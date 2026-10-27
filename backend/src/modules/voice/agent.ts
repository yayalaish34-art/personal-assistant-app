import { z } from 'zod';
import type OpenAI from 'openai';

import { getOpenAI } from '../chat/llm.js';
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { reviewSchedule, type KnownEvent, type ProposedEvent } from './schedule.js';
import { findTime, today, type AvailabilityEvent } from './availability.js';
import { geocode, distanceKm, travelMinutes, searchNearby } from './travel.js';

// The voice assistant's turn: what she heard in, what she says back plus the
// changes to apply.
//
// This is the stateless sibling of /chat/message. That endpoint owns rows in
// the database; this one owns nothing. The device stores its own tasks and
// events, so it sends a snapshot of them with every turn and applies the
// actions that come back. The model therefore never touches the data — it
// proposes, the device executes, and an id the model invents cannot match
// anything in the snapshot and is dropped here before it is ever returned.

// ─── Snapshot: what the device knows ────────────────────────────────────────

export const snapshotSchema = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        notes: z.string().nullish(),
        dueAt: z.string().nullish(),
        isDone: z.boolean().default(false),
      }),
    )
    .max(200)
    .default([]),
  events: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        note: z.string().nullish(),
        startsAt: z.string(),
        endsAt: z.string().nullish(),
        /** Free text, as the user typed it. Geocoded when a journey is checked. */
        location: z.string().nullish(),
      }),
    )
    .max(200)
    .default([]),
  // Everything below arrived after tasks and events, so an older install sends
  // none of it and each list defaults to empty rather than failing the turn.
  /** What is on the shopping list, bought or not. */
  shopping: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        quantity: z.string().nullish(),
        isBought: z.boolean().default(false),
      }),
    )
    .max(200)
    .default([]),
  /** Income and expenses, this month and the one before. */
  money: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(['income', 'expense']),
        description: z.string(),
        amount: z.number().finite(),
        date: z.string(),
        category: z.string().nullish(),
      }),
    )
    .max(400)
    .default([]),
  /** Money owed either way. */
  debts: z
    .array(
      z.object({
        id: z.string().min(1),
        direction: z.enum(['owe', 'owed']),
        person: z.string(),
        amount: z.number().finite(),
        description: z.string().nullish(),
        isSettled: z.boolean().default(false),
      }),
    )
    .max(100)
    .default([]),
  /** Monthly limit per expense category, as the user set them. */
  budgets: z.record(z.string(), z.number().finite()).default({}),
  /** ISO 4217, so she says amounts in the right money. */
  currency: z.string().max(8).nullish(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

// ─── Profile: what the opening questionnaire learned ────────────────────────

/**
 * The answers from onboarding, as the device holds them.
 *
 * Every field has a default, because the questionnaire can be skipped and
 * because an install from before it existed sends nothing at all. Nothing here
 * is required for a turn to work — it makes her answers fit the person rather
 * than the average one.
 */
export const profileSchema = z.object({
  workStartHour: z.number().int().min(0).max(23).default(9),
  workEndHour: z.number().int().min(0).max(23).default(18),
  sleepStartHour: z.number().int().min(0).max(23).default(23),
  sleepEndHour: z.number().int().min(0).max(23).default(7),
  bufferMinutes: z.number().int().min(0).max(120).default(15),
  taskReminderMinutes: z.number().int().min(0).max(1440).default(15),
  eventTypes: z.array(z.string().max(40)).max(20).default([]),
  fixedCommitments: z.string().max(500).default(''),
  workDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  focusPeriod: z.enum(['morning', 'afternoon', 'evening', 'flexible']).optional(),
  primaryGoal: z.enum(['balance', 'productivity', 'lessStress', 'health', 'finances']).optional(),
  sleepQuality: z.enum(['rested', 'tired', 'irregular', 'unspecified']).optional(),
  assistanceStyle: z.enum(['brief', 'guided', 'proactive']).optional(),
});

export type Profile = z.infer<typeof profileSchema>;

// ─── Tools the device executes ──────────────────────────────────────────────

/**
 * Anything that touches an existing entry has to name it as well as identify
 * it. Asked to delete a meeting that isn't there, the model would otherwise
 * pick the nearest row and announce it as the one the user named — which is
 * how "delete my bank meeting" quietly deleted a standup during testing.
 * Writing the title out forces the mismatch into the model's own output, and
 * the server checks it against the row before the action ever reaches the
 * device.
 */
const MATCH_TITLE_HELP =
  'The exact title of the entry you are acting on, copied from the agenda. It must be the entry the user actually named.';

export const ACTION_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'create_image',
      description:
        'Draw a picture, when the user asks for one — an image, a drawing, an illustration. Not for anything that belongs on the agenda.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              "What to draw, in English and in full, however the user phrased it. Say what is in the picture and how it looks; do not name a style unless the user did.",
          },
          shape: {
            type: 'string',
            enum: ['square', 'portrait', 'landscape'],
            description: 'Omit unless the user asked for a shape.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_task',
      description: 'Add a new task (something to do, with an optional due date).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title, no dates or filler words.' },
          dueAt: {
            type: 'string',
            description: 'ISO-8601 with offset. Omit for a task with no date.',
          },
          notes: { type: 'string' },
          priority: { type: 'string', enum: ['Low', 'Medium', 'High'] },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description:
        'Change an existing task. The id must come from the agenda you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
          title: { type: 'string', description: 'The new title, if it is changing.' },
          dueAt: { type: ['string', 'null'], description: 'ISO-8601 with offset, or null to clear.' },
          notes: { type: 'string' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'complete_task',
      description: 'Mark a task as done.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_task',
      description: 'Delete a task for good.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_shopping_item',
      description:
        'Put something on the shopping list — groceries and household things to buy. Not a task and not an appointment: use create_task when it is something to do rather than something to buy.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The item alone, no quantity words.' },
          quantity: {
            type: 'string',
            description: 'As the user said it — "2", "500g", "a bunch". Omit if they gave none.',
          },
          note: { type: 'string', description: 'Anything extra they specified, such as a brand.' },
          category: {
            type: 'string',
            enum: ['produce', 'dairy', 'meat', 'bakery', 'cleaning', 'pharmacy', 'other'],
            description: 'The aisle, when it is obvious. Omit rather than guessing.',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_money_entry',
      description:
        'Record money that came in or went out, when the user says they earned, spent or paid something.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['income', 'expense'] },
          description: { type: 'string', description: 'What it was for, in a few words.' },
          amount: { type: 'number', description: 'A positive number. `kind` carries the direction.' },
          date: {
            type: 'string',
            description: 'YYYY-MM-DD. Defaults to today when the user did not say.',
          },
          category: {
            type: 'string',
            enum: [
              'salary',
              'business',
              'refund',
              'gift',
              'shopping',
              'food',
              'housing',
              'bills',
              'transport',
              'health',
              'fun',
              'other',
            ],
            description:
              'Income takes salary/business/refund/gift/other; an expense takes the rest. Omit rather than guessing.',
          },
        },
        required: ['kind', 'description', 'amount'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_shopping_item',
      description:
        'Tick something off the shopping list because the user bought it. The id must come from the shopping list you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: 'The item name exactly as on the list.' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remove_shopping_item',
      description: 'Take something off the shopping list because it is no longer needed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: 'The item name exactly as on the list.' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_money_entry',
      description:
        'Remove an income or expense that was recorded by mistake. The id must come from the money list you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: 'The description exactly as on the list.' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_debt',
      description:
        'Record money owed between the user and someone else — "Dan owes me 200", "I owe mum 50".',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['owe', 'owed'],
            description: '"owe" when the user owes them; "owed" when they owe the user.',
          },
          person: { type: 'string', description: 'Who, by name.' },
          amount: { type: 'number', description: 'A positive number.' },
          description: { type: 'string', description: 'What it was for, if they said.' },
        },
        required: ['direction', 'person', 'amount'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'settle_debt',
      description:
        'Mark a debt as paid back. The id must come from the debts list you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: 'The person’s name exactly as on the list.' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_cards',
      description:
        'Show structured content as visual cards on screen. Use when there are multiple options to choose from, recommendations, a summary with key points, or a comparison — anything a spoken list would be awkward for. Each card has a short heading and optional detail.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Optional heading above the cards.',
          },
          cards: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Card heading, a few words.' },
                detail: { type: 'string', description: 'One line of extra info.' },
              },
              required: ['label'],
            },
            minItems: 2,
            maxItems: 6,
            description: 'The cards to show.',
          },
          selectable: {
            type: 'boolean',
            description: 'True when the user should pick one. Default false.',
          },
        },
        required: ['cards'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_checklist',
      description:
        'Show a list of tasks or shopping items as an interactive checklist with checkboxes the user can tap to mark done. Use when listing tasks, things to buy, or anything they might check off.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Heading above the list.' },
          kind: {
            type: 'string',
            enum: ['tasks', 'shopping'],
            description: 'What kind of items.',
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'The id from the agenda.' },
                label: { type: 'string', description: 'The item text.' },
                checked: { type: 'boolean', description: 'Already done / bought.' },
                detail: { type: 'string', description: 'Extra info — due date, quantity.' },
              },
              required: ['id', 'label', 'checked'],
            },
            maxItems: 20,
          },
        },
        required: ['kind', 'items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_confirmation',
      description:
        'Show a visual confirmation card after creating or modifying something — a task, event, expense, debt. Call alongside the tool that made the change.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What happened, in the user\'s language.' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
              },
              required: ['label', 'value'],
            },
            maxItems: 6,
          },
        },
        required: ['title', 'fields'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_budget',
      description:
        'Show spending by category as visual progress bars against budgets. Use when discussing how much was spent, budget status, or financial summaries.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Category name.' },
                spent: { type: 'number', description: 'Amount spent.' },
                limit: { type: 'number', description: 'Budget limit.' },
              },
              required: ['name', 'spent', 'limit'],
            },
            maxItems: 10,
          },
        },
        required: ['categories'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_timeline',
      description:
        "Show the day's schedule as a visual timeline with time blocks. Use when describing what the day or a specific day looks like.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'E.g. "היום שלך" or "Wednesday".' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                start: { type: 'string', description: 'HH:MM.' },
                end: { type: 'string', description: 'HH:MM. Omit if unknown.' },
              },
              required: ['title', 'start'],
            },
            maxItems: 12,
          },
        },
        required: ['events'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_actions',
      description:
        'Show 2–4 quick action chips the user can tap as follow-ups. Use after answering to suggest what they might want next.',
      parameters: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short label, 2–4 words.' },
              },
              required: ['label'],
            },
            minItems: 2,
            maxItems: 4,
          },
        },
        required: ['actions'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_debt',
      description:
        'Show open debts as visual cards with a settle button. Use when discussing who owes whom.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          debts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Debt id from the debts list.' },
                person: { type: 'string' },
                amount: { type: 'number' },
                direction: { type: 'string', enum: ['owe', 'owed'] },
                description: { type: 'string' },
              },
              required: ['id', 'person', 'amount', 'direction'],
            },
            maxItems: 10,
          },
        },
        required: ['debts'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_weather',
      description:
        'Show a weather forecast as a visual card. Use whenever the user asks about the weather.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string' },
          days: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                day: { type: 'string', description: 'Day label, e.g. "Today", "Tomorrow", "Wednesday"' },
                icon: { type: 'string', enum: ['sun', 'cloud', 'rain', 'storm', 'snow', 'partly_cloudy', 'wind', 'fog'] },
                high: { type: 'number' },
                low: { type: 'number' },
                description: { type: 'string', description: 'Short description like "Sunny and warm"' },
              },
              required: ['day', 'icon', 'high', 'low'],
            },
            maxItems: 7,
          },
        },
        required: ['days'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'present_summary',
      description:
        'Show a summary card with stats and highlights. Use for daily summaries, weekly reviews, or any overview with numbers.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          stats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                trend: { type: 'string', enum: ['up', 'down', 'neutral'], description: 'Optional trend indicator' },
              },
              required: ['label', 'value'],
            },
            maxItems: 6,
          },
          highlights: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 5,
            description: 'Key highlights or notes as short strings.',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'plan_recurring_goal',
      description:
        "Turn a weekly goal into real calendar slots. Given a title ('workout', 'studying', 'calling clients'), a count per week, and a rough duration, this searches the coming week's free windows and picks that many non-adjacent slots that actually fit — travel and sleep already subtracted. Returns the proposed slot list; the user says yes, you call create_event per slot. Use this instead of making the user pick times by hand.",
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short name of the recurring thing — "workout", "deep work", "piano practice". No dates or filler.',
          },
          timesPerWeek: {
            type: 'number',
            description: 'How many slots to find across the week. 1–7.',
          },
          durationMinutes: {
            type: 'number',
            description: 'Rough length of one slot. Default 60.',
          },
          preferredPeriod: {
            type: 'string',
            enum: ['morning', 'afternoon', 'evening', 'any'],
            description: 'When in the day. Default any — call it only when the user said so.',
          },
        },
        required: ['title', 'timesPerWeek'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cluster_errands',
      description:
        "Scan the next few days of events looking for pairs or more that sit in the same place or area, so you can propose consolidating a trip or dropping something in on a day the user is already heading that way. Returns the clusters it found (what's happening in what city, on which day). Call this when the user asks about the week ahead, when they add an event in a place that already appears, or when they ask whether something can be batched.",
      parameters: {
        type: 'object',
        properties: {
          lookAheadDays: {
            type: 'number',
            description: 'How many days to scan. Default 7, max 14.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'end_of_day',
      description:
        "The evening close ritual: what landed today, what slipped, what tomorrow starts with. Returns the numbers so you can hand the user a short, non-shaming recap: 'you shipped nine, two moved to tomorrow, you start with the dentist at 9'. Use this at or near the user's wind-down hour, when they ask 'how did today go', or whenever the day is clearly over for them. Pair with replan_remainder if things slipped.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_weather',
      description:
        "Fetch the current weather and the next-24h forecast for the user's area. Call this when the user asks about the weather, when an outdoor errand is on the schedule and conditions could matter, or whenever a plan would read differently in rain. Returns temperature, precipitation chance by hour, and a short condition code. Prefer present_weather to show the forecast; use the fetched facts to decide whether to suggest moving an outdoor plan.",
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'How many days of forecast to pull. Default 2, max 7.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'replan_remainder',
      description:
        "When the day has slipped — a meeting ran long, a task was missed, the user says they could not get to things — this computes where undone work can land next, in free windows across the next few days, respecting travel and sleep. Returns a proposed redistribution: which task moves to which window, with the reason. The user can accept with a simple yes, and you follow up with update_task calls carrying the new dueAt values. Do not call this unless there is actually something to redistribute.",
      parameters: {
        type: 'object',
        properties: {
          lookAheadDays: {
            type: 'number',
            description: 'How many days forward to search. Default 3, max 7.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'budget_alert',
      description:
        "Look at each category budget against spending so far this month and the days remaining, and flag the categories at risk of overrun BEFORE it happens. Returns findings like 'food: 72% spent with 11 days left — on pace to overshoot by ~₪240'. Call this when the user asks how their budget is going, how much is left, or whether something they are about to spend fits. Also call it in the morning briefing when a category has already crossed a warning threshold. Say the risk plainly and give one concrete option — slow down, reallocate, or accept it.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'weekly_summary',
      description:
        "Produce the end-of-week recap: tasks finished, upcoming events for the next week, money in and out this week, biggest spending category, which days were packed. Use for an evening or weekend 'how did my week go' conversation, and when the user asks for a review. Return the raw numbers; present_summary is the right surface to render them.",
      parameters: {
        type: 'object',
        properties: {
          weeksBack: {
            type: 'number',
            description: '0 for the current week to date, 1 for last week finished. Default 0.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'suggest_opportunity',
      description:
        "Find the one most-useful thing the user could do right now, by cross-referencing their current location, their next commitment, their free window after travel, and whatever is on their shopping list or task list. This is the 'you're near the mall, you have 45 minutes before Eliran, want to grab Nofar's gift?' moment: the server does the math, you turn it into one short, specific proposal. Call this when the user asks what they should do now, when they are checking in during a gap, at session start when the day has a clear window, or whenever a nearby place and an open window line up with something waiting. Returns null-like when nothing fits — in that case do NOT invent a suggestion.",
      parameters: {
        type: 'object',
        properties: {
          minWindowMinutes: {
            type: 'number',
            description: 'Shortest free window worth suggesting into. Default 20.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'spending_trends',
      description:
        "Compare this month's spending to last month's, category by category, and surface the categories that climbed meaningfully. Returns findings with absolute and percentage change, so you can say things like 'deliveries up 28% versus last month — going back to the previous average saves roughly ₪450 per month'. Call this when the user asks how their spending is going, when they ask where their money went, when they ask what to cut, or whenever you are about to say 'you spent X' and want the comparison in the sentence.",
      parameters: {
        type: 'object',
        properties: {
          minPercent: {
            type: 'number',
            description: 'Minimum percentage increase to report. Default 15.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'upcoming_debits',
      description:
        "Project recurring debits — subscriptions, rent, standing bills — forward from the user's history, so you can warn them about charges due in the next 30 days before the money is gone. Finds expense descriptions that repeated across months, estimates when the next hit lands, and totals it. Call this when the user asks what is coming up, whether they can afford something, how much is left, or when they ask you to help them plan the next couple of weeks.",
      parameters: {
        type: 'object',
        properties: {
          horizonDays: {
            type: 'number',
            description: 'How far forward to project. Default 30, max 90.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_nearby',
      description:
        "Find real places near the user's current location. Call this when the user asks what is nearby, where to shop, eat, get coffee, find a pharmacy, etc. Returns actual named places with distances.",
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['shopping', 'supermarket', 'mall', 'restaurant', 'cafe', 'pharmacy', 'gas_station', 'gym', 'park', 'hospital', 'bank', 'hotel'],
            description: 'What kind of place to search for.',
          },
          radiusMeters: {
            type: 'number',
            description: 'Search radius in meters. Default 3000 (3km). Use larger for sparse areas.',
          },
        },
        required: ['category'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_travel',
      description:
        "Estimate travel time from the user's current location to a destination. Call this when the user asks 'can I make it?', 'how far is X?', 'how long to get to...', or whenever you need to know travel time from where they are now. Requires the user's location to be available.",
      parameters: {
        type: 'object',
        properties: {
          destination: {
            type: 'string',
            description: 'The place to travel to — a city, a venue, an address.',
          },
        },
        required: ['destination'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_free_time',
      description:
        "Work out when the user is actually free. Call this for ANY question about free time, availability, gaps, or when something could fit — and before suggesting a time for anything. Do not read the agenda and work it out yourself: this accounts for meetings that carry no end time, for travel between places, and for evenings that an event has effectively taken over, none of which are visible in the agenda text.",
      parameters: {
        type: 'object',
        properties: {
          fromDate: {
            type: 'string',
            description: 'YYYY-MM-DD to start looking from. Omit for today.',
          },
          eveningOnly: {
            type: 'boolean',
            description:
              'True when they asked for an evening. Skips evenings already taken by a wedding, a flight and the like, and moves to the next day.',
          },
          minutesNeeded: {
            type: 'number',
            description: 'Roughly how long the thing takes. Omit if they did not say.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_event',
      description: 'Put something in the calendar at a set time.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startsAt: { type: 'string', description: 'ISO-8601 with offset.' },
          endsAt: { type: 'string', description: 'ISO-8601 with offset. Defaults to an hour later.' },
          note: { type: 'string' },
          location: {
            type: 'string',
            description:
              'Where it happens, if the user said — a city, a place, an address. Used to work out whether they can get there in time from whatever is before it.',
          },
        },
        required: ['title', 'startsAt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_event',
      description: 'Move or rename an event. The id must come from the agenda you were given.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
          title: { type: 'string', description: 'The new title, if it is changing.' },
          startsAt: { type: 'string' },
          endsAt: { type: 'string' },
          note: { type: 'string' },
          location: { type: 'string', description: 'Where it happens, if that is changing.' },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'delete_event',
      description: 'Remove an event from the calendar.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          matchTitle: { type: 'string', description: MATCH_TITLE_HELP },
        },
        required: ['id', 'matchTitle'],
      },
    },
  },
];

const isoString = z.string().min(4);

const ARG_SCHEMAS = {
  // Owns no row, so it is checked against nothing: no id to verify, and
  // nothing on the agenda it could duplicate.
  create_image: z.object({
    prompt: z.string().min(1).max(1000),
    shape: z.enum(['square', 'portrait', 'landscape']).optional(),
  }),
  create_task: z.object({
    title: z.string().min(1),
    dueAt: isoString.optional(),
    notes: z.string().optional(),
    priority: z.enum(['Low', 'Medium', 'High']).optional(),
  }),
  update_task: z.object({
    id: z.string().min(1),
    matchTitle: z.string().min(1),
    title: z.string().min(1).optional(),
    dueAt: z.union([isoString, z.null()]).optional(),
    notes: z.string().optional(),
  }),
  complete_task: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  delete_task: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  add_shopping_item: z.object({
    name: z.string().min(1).max(200),
    quantity: z.string().max(60).optional(),
    note: z.string().max(300).optional(),
    category: z
      .enum(['produce', 'dairy', 'meat', 'bakery', 'cleaning', 'pharmacy', 'other'])
      .optional(),
  }),
  add_money_entry: z.object({
    kind: z.enum(['income', 'expense']),
    description: z.string().min(1).max(300),
    // Positive only: `kind` is what carries the sign, and a negative expense
    // would subtract twice once the device applies it.
    amount: z.number().positive().finite(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    category: z
      .enum([
        'salary',
        'business',
        'refund',
        'gift',
        'shopping',
        'food',
        'housing',
        'bills',
        'transport',
        'health',
        'fun',
        'other',
      ])
      .optional(),
  }),
  check_shopping_item: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  remove_shopping_item: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  delete_money_entry: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  add_debt: z.object({
    direction: z.enum(['owe', 'owed']),
    person: z.string().min(1).max(120),
    amount: z.number().positive().finite(),
    description: z.string().max(300).optional(),
  }),
  settle_debt: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
  present_cards: z.object({
    title: z.string().max(200).optional(),
    cards: z
      .array(
        z.object({
          label: z.string().min(1).max(100),
          detail: z.string().max(300).optional(),
        }),
      )
      .min(2)
      .max(6),
    selectable: z.boolean().optional(),
  }),
  present_checklist: z.object({
    title: z.string().max(200).optional(),
    kind: z.enum(['tasks', 'shopping']),
    items: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1).max(200),
          checked: z.boolean(),
          detail: z.string().max(200).optional(),
        }),
      )
      .max(20),
  }),
  present_confirmation: z.object({
    title: z.string().min(1).max(200),
    fields: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          value: z.string().min(1).max(200),
        }),
      )
      .max(6),
  }),
  present_budget: z.object({
    title: z.string().max(200).optional(),
    categories: z
      .array(
        z.object({
          name: z.string().min(1).max(60),
          spent: z.number().finite(),
          limit: z.number().positive().finite(),
        }),
      )
      .max(10),
  }),
  present_timeline: z.object({
    title: z.string().max(200).optional(),
    events: z
      .array(
        z.object({
          title: z.string().min(1).max(200),
          start: z.string().regex(/^\d{1,2}:\d{2}$/),
          end: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
        }),
      )
      .max(12),
  }),
  present_actions: z.object({
    actions: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
        }),
      )
      .min(2)
      .max(4),
  }),
  present_debt: z.object({
    title: z.string().max(200).optional(),
    debts: z
      .array(
        z.object({
          id: z.string().min(1),
          person: z.string().min(1).max(120),
          amount: z.number().positive().finite(),
          direction: z.enum(['owe', 'owed']),
          description: z.string().max(200).optional(),
        }),
      )
      .max(10),
  }),
  present_weather: z.object({
    location: z.string().max(120).optional(),
    days: z
      .array(
        z.object({
          day: z.string().min(1).max(30),
          icon: z.enum(['sun', 'cloud', 'rain', 'storm', 'snow', 'partly_cloudy', 'wind', 'fog']),
          high: z.number().finite(),
          low: z.number().finite(),
          description: z.string().max(120).optional(),
        }),
      )
      .max(7),
  }),
  present_summary: z.object({
    title: z.string().min(1).max(200),
    stats: z
      .array(
        z.object({
          label: z.string().min(1).max(60),
          value: z.string().min(1).max(60),
          trend: z.enum(['up', 'down', 'neutral']).optional(),
        }),
      )
      .max(6)
      .optional(),
    highlights: z.array(z.string().max(200)).max(5).optional(),
  }),
  plan_recurring_goal: z.object({
    title: z.string().min(1).max(80),
    timesPerWeek: z.number().int().min(1).max(7),
    durationMinutes: z.number().positive().max(8 * 60).optional(),
    preferredPeriod: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
  }),
  cluster_errands: z.object({
    lookAheadDays: z.number().int().min(1).max(14).optional(),
  }),
  end_of_day: z.object({}),
  check_weather: z.object({
    days: z.number().positive().max(7).optional(),
  }),
  replan_remainder: z.object({
    lookAheadDays: z.number().positive().max(7).optional(),
  }),
  budget_alert: z.object({}),
  weekly_summary: z.object({
    weeksBack: z.number().int().min(0).max(4).optional(),
  }),
  suggest_opportunity: z.object({
    minWindowMinutes: z.number().positive().max(24 * 60).optional(),
  }),
  spending_trends: z.object({
    minPercent: z.number().positive().max(1000).optional(),
  }),
  upcoming_debits: z.object({
    horizonDays: z.number().positive().max(90).optional(),
  }),
  find_nearby: z.object({
    category: z.enum(['shopping', 'supermarket', 'mall', 'restaurant', 'cafe', 'pharmacy', 'gas_station', 'gym', 'park', 'hospital', 'bank', 'hotel']),
    radiusMeters: z.number().positive().max(50_000).optional(),
  }),
  check_travel: z.object({
    destination: z.string().min(1).max(200),
  }),
  find_free_time: z.object({
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    eveningOnly: z.boolean().optional(),
    minutesNeeded: z.number().positive().max(24 * 60).optional(),
  }),
  create_event: z.object({
    title: z.string().min(1),
    startsAt: isoString,
    endsAt: isoString.optional(),
    note: z.string().optional(),
    location: z.string().max(120).optional(),
  }),
  update_event: z.object({
    id: z.string().min(1),
    matchTitle: z.string().min(1),
    title: z.string().min(1).optional(),
    startsAt: isoString.optional(),
    endsAt: isoString.optional(),
    note: z.string().optional(),
    location: z.string().max(120).optional(),
  }),
  delete_event: z.object({ id: z.string().min(1), matchTitle: z.string().min(1) }),
} as const;

export type ActionName = keyof typeof ARG_SCHEMAS;

function isActionName(name: string): name is ActionName {
  return name in ARG_SCHEMAS;
}

type IdSource = 'tasks' | 'events' | 'shopping' | 'money' | 'debts';

/** Which snapshot list an action's `id` has to be found in, if it has one. */
const ID_SOURCE: Partial<Record<ActionName, IdSource>> = {
  update_task: 'tasks',
  complete_task: 'tasks',
  delete_task: 'tasks',
  update_event: 'events',
  delete_event: 'events',
  check_shopping_item: 'shopping',
  remove_shopping_item: 'shopping',
  delete_money_entry: 'money',
  settle_debt: 'debts',
};

/**
 * The words a row is known by — what `matchTitle` has to repeat. Each list
 * names its rows differently, and the check is the same for all of them.
 */
function rowsOf(snapshot: Snapshot, source: IdSource): { id: string; title: string }[] {
  switch (source) {
    case 'tasks':
      return snapshot.tasks;
    case 'events':
      return snapshot.events;
    case 'shopping':
      return snapshot.shopping.map((r) => ({ id: r.id, title: r.name }));
    case 'money':
      return snapshot.money.map((r) => ({ id: r.id, title: r.description }));
    case 'debts':
      return snapshot.debts.map((r) => ({ id: r.id, title: r.person }));
  }
}

/** The day an ISO timestamp falls on, or null when there isn't one. */
function dayOf(iso: string | null | undefined, timezone: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Is this create just re-adding something already on the agenda?
 *
 * Asked to add one task and describe the day, the model would sometimes
 * "add" an entry it had merely read out, leaving a duplicate behind. Same
 * title on the same day is not a second thing to do — it is the same thing
 * twice, and the user hears one confirmation either way.
 *
 * A finished task is not in the way: the snapshot carries completed rows so
 * she can say what got done, and someone who ticked off "buy milk" this
 * morning and asks for it again this evening means it.
 */
export function alreadyOnAgenda(
  name: ActionName,
  args: Record<string, unknown>,
  snapshot: Snapshot,
  timezone: string,
): boolean {
  // The list is one list, not one per day: milk that is still waiting to be
  // bought is on it already, whenever it was put there.
  if (name === 'add_shopping_item') {
    const item = normalizeTitle(String(args.name ?? ''));
    return (
      item.length > 0 &&
      snapshot.shopping.some((s) => !s.isBought && normalizeTitle(s.name) === item)
    );
  }

  const title = normalizeTitle(String(args.title ?? ''));
  if (!title) return false;

  if (name === 'create_task') {
    const day = dayOf(args.dueAt as string | undefined, timezone);
    return snapshot.tasks.some(
      (t) => !t.isDone && normalizeTitle(t.title) === title && dayOf(t.dueAt, timezone) === day,
    );
  }
  if (name === 'create_event') {
    const day = dayOf(args.startsAt as string | undefined, timezone);
    return snapshot.events.some(
      (e) => normalizeTitle(e.title) === title && dayOf(e.startsAt, timezone) === day,
    );
  }
  return false;
}

/**
 * `offer_times` is the one the model cannot ask for. The server raises it in
 * place of a create or a move it has judged unkeepable, so it is not in
 * `ACTION_TOOLS` and has no argument schema — nothing untrusted ever produces
 * one.
 */
export interface VoiceAction {
  tool: ActionName | 'offer_times';
  arguments: Record<string, unknown>;
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

/**
 * Only the opening greeting needs this: she answers every real turn in
 * whatever language the user spoke, but "[SESSION START]" carries no words of
 * theirs to mirror, so the interface language stands in.
 *
 * Every language the interface ships in is here. A code that is not — the
 * route validates the shape of an ISO-639-1 code, not the particular language
 * — greets in English rather than failing the turn.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  he: 'Hebrew',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ru: 'Russian',
  de: 'German',
  pt: 'Portuguese',
  hi: 'Hindi',
  zh: 'Chinese (Simplified)',
  ja: 'Japanese',
  ko: 'Korean',
  tr: 'Turkish',
  nl: 'Dutch',
  pl: 'Polish',
  uk: 'Ukrainian',
  ro: 'Romanian',
  el: 'Greek',
  sv: 'Swedish',
  fa: 'Persian',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
  bn: 'Bengali',
};

/**
 * What she says when the audio carried no words she could make out.
 *
 * Written out per language rather than generated, because this is the one
 * reply that must not cost a model call: it is the answer to a turn that
 * already wasted the user's few seconds, and adding two more to it is how a
 * missed word starts to feel like a broken app. Anything not listed falls back
 * to English, the same way the greeting does.
 *
 * Kept short on purpose — it is spoken aloud, and a long apology for not
 * hearing something is worse than the not hearing.
 */
const NOT_CAUGHT: Record<string, string> = {
  en: "Sorry, I didn't catch that — say it again?",
  he: 'סליחה, לא תפסתי את זה — אפשר שוב?',
  ar: 'عذرًا، لم أسمع ذلك — مرة أخرى؟',
  es: 'Perdona, no te he oído bien. ¿Lo repites?',
  fr: "Désolée, je n'ai pas saisi — tu peux répéter ?",
  it: 'Scusa, non ho capito — me lo ripeti?',
  ru: 'Извини, я не расслышала — повторишь?',
  de: 'Entschuldige, das habe ich nicht verstanden — noch mal?',
  pt: 'Desculpa, não percebi — podes repetir?',
  hi: 'माफ़ करना, मैं समझ नहीं पाई — फिर से कहेंगे?',
  zh: '抱歉，我没听清，可以再说一遍吗？',
  ja: 'ごめんなさい、聞き取れませんでした。もう一度お願いします。',
  ko: '죄송해요, 잘 못 들었어요. 다시 말씀해 주시겠어요?',
  tr: 'Pardon, anlayamadım — tekrar eder misin?',
  nl: 'Sorry, dat heb ik niet verstaan — nog een keer?',
  pl: 'Przepraszam, nie dosłyszałam — możesz powtórzyć?',
  uk: 'Вибач, я не розчула — повториш?',
  ro: 'Scuze, nu am prins — mai zici o dată?',
  el: 'Συγγνώμη, δεν το έπιασα — το λες ξανά;',
  sv: 'Förlåt, jag hörde inte — kan du säga det igen?',
  fa: 'ببخشید، متوجه نشدم — دوباره می‌گویی؟',
  id: 'Maaf, aku tidak menangkapnya — bisa diulang?',
  vi: 'Xin lỗi, mình chưa nghe rõ — bạn nói lại nhé?',
  th: 'ขอโทษค่ะ ฟังไม่ทัน พูดอีกครั้งได้ไหมคะ',
  bn: 'দুঃখিত, ঠিক শুনতে পাইনি — আবার বলবেন?',
};

/** The "say that again" line, in `language`, falling back to English. */
export function didNotCatchThat(language: string): string {
  return NOT_CAUGHT[language] ?? NOT_CAUGHT.en!;
}

/**
 * The agenda goes into the prompt rather than behind a lookup tool: the device
 * already has it, and one round trip is the difference between a conversation
 * and a wait.
 */
function describeSnapshot(snapshot: Snapshot, timezone: string): string {
  const when = (iso: string | null | undefined) => {
    if (!iso) return 'no date';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'no date';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(d);
  };

  const tasks = snapshot.tasks.length
    ? snapshot.tasks
        .map(
          (t) =>
            `- [${t.id}] ${t.title} — due ${when(t.dueAt)}${t.isDone ? ' (done)' : ''}${
              t.notes ? ` — ${t.notes}` : ''
            }`,
        )
        .join('\n')
    : '- (none)';

  const events = snapshot.events.length
    ? snapshot.events
        .map((e) => `- [${e.id}] ${e.title} — ${when(e.startsAt)}${e.note ? ` — ${e.note}` : ''}`)
        .join('\n')
    : '- (none)';

  return `TASKS:\n${tasks}\n\nCALENDAR:\n${events}`;
}

/** YYYY-MM of an instant, in the user's zone. */
function monthOf(now: Date, timezone: string, back = 0): string {
  const [y, m] = (dayOf(now.toISOString(), timezone) ?? '1970-01-01').split('-').map(Number);
  const d = new Date(Date.UTC(y!, m! - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The list, the money and the debts, as the prompt sees them.
 *
 * Totals are added up here, not left to the model: asked "how much did I spend
 * on food", it would otherwise sum a column of figures in its head, and a
 * finance answer that is roughly right is wrong.
 */
export function describeHousehold(snapshot: Snapshot, timezone: string, now: Date): string {
  const cur = snapshot.currency ? ` ${snapshot.currency}` : '';
  const amt = (n: number) => `${Math.round(n * 100) / 100}${cur}`;

  const open = snapshot.shopping.filter((s) => !s.isBought);
  const inTrolley = snapshot.shopping.filter((s) => s.isBought);
  const shopping = [
    open.length
      ? open.map((s) => `- [${s.id}] ${s.name}${s.quantity ? ` (${s.quantity})` : ''}`).join('\n')
      : '- (nothing to buy)',
    ...(inTrolley.length
      ? [`Already bought: ${inTrolley.map((s) => `[${s.id}] ${s.name}`).join(', ')}`]
      : []),
  ].join('\n');

  const months = [monthOf(now, timezone), monthOf(now, timezone, 1)];
  const summary = months
    .map((month, i) => {
      const rows = snapshot.money.filter((m) => m.date.startsWith(month));
      const income = rows.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amount, 0);
      const spent = rows.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount, 0);
      const byCat = new Map<string, number>();
      for (const r of rows) {
        if (r.kind !== 'expense') continue;
        const key = r.category ?? 'uncategorised';
        byCat.set(key, (byCat.get(key) ?? 0) + r.amount);
      }
      const cats = [...byCat.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => {
          const limit = snapshot.budgets[k];
          return `${k} ${amt(v)}${limit ? ` of a ${amt(limit)} budget` : ''}`;
        })
        .join(', ');
      return `${i === 0 ? 'This month' : 'Last month'} (${month}): income ${amt(income)}, spent ${amt(spent)}, balance ${amt(income - spent)}${cats ? `. Spending by category: ${cats}` : ''}.`;
    })
    .join('\n');

  const recent = snapshot.money
    .filter((m) => m.date.startsWith(months[0]!))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 40)
    .map(
      (m) =>
        `- [${m.id}] ${m.date} ${m.kind === 'income' ? '+' : '-'}${amt(m.amount)} ${m.description}${m.category ? ` (${m.category})` : ''}`,
    )
    .join('\n');

  const openDebts = snapshot.debts.filter((d) => !d.isSettled);
  const owe = openDebts.filter((d) => d.direction === 'owe').reduce((s, d) => s + d.amount, 0);
  const owed = openDebts.filter((d) => d.direction === 'owed').reduce((s, d) => s + d.amount, 0);
  const debts = openDebts.length
    ? [
        `The user owes ${amt(owe)} in total; others owe the user ${amt(owed)}.`,
        ...openDebts.map(
          (d) =>
            `- [${d.id}] ${d.person} — ${d.direction === 'owe' ? 'the user owes them' : 'owes the user'} ${amt(d.amount)}${d.description ? ` for ${d.description}` : ''}`,
        ),
      ].join('\n')
    : '- (no open debts)';

  return [
    `SHOPPING LIST:\n${shopping}`,
    `MONEY (already added up — quote these totals, never add figures yourself):\n${summary}\nThis month's entries:\n${recent || '- (none)'}`,
    `OPEN DEBTS:\n${debts}`,
  ].join('\n\n');
}

/**
 * The next week, named and dated.
 *
 * Left to work it out from a single timestamp, the model gets "tomorrow" wrong
 * often enough to move a real meeting to the wrong day — it did exactly that
 * in testing. Spelling the days out turns the arithmetic into a lookup.
 */
function describeDays(now: Date, timezone: string): string {
  const dayName = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
  // en-CA gives YYYY-MM-DD, which is the shape the model has to echo back.
  const isoDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const labels = ['Today', 'Tomorrow'];
  const lines: string[] = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const label = labels[i] ?? `In ${i} days`;
    lines.push(`- ${label}: ${dayName.format(d)} ${isoDay.format(d)}`);
  }
  return lines.join('\n');
}

/**
 * The profile as a few lines of instruction.
 *
 * Working hours are here rather than in the slot finder on purpose: whether an
 * evening is acceptable depends on what the thing *is*, which is a judgement,
 * and a hard rule would refuse someone a dinner because they clock off at six.
 * Sleep and the buffer are enforced mechanically as well — those need no
 * judgement — and saying so here keeps her explanation and the offered times
 * telling the same story.
 */
function describeProfile(p: Profile): string {
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const lines = [
    `- Works ${hour(p.workStartHour)}–${hour(p.workEndHour)}. Prefer these hours for anything`,
    '  work-shaped, and if they ask for something well outside them, say so in passing',
    '  rather than refusing — evenings and weekends are theirs to use.',
    `- Asleep ${hour(p.sleepStartHour)}–${hour(p.sleepEndHour)}. Never propose anything in there.`,
    `- Likes ${p.bufferMinutes} minutes between one thing and the next.`,
    `- Task reminders fire ${p.taskReminderMinutes === 0 ? 'exactly at the due time' : `${p.taskReminderMinutes} minutes before the due time`}. Mention this when creating a dated task so they know what to expect.`,
  ];
  if (p.eventTypes.length) {
    lines.push(`- Their days are mostly: ${p.eventTypes.join(', ')}.`);
  }
  if (p.fixedCommitments.trim()) {
    lines.push(
      `- Standing commitments, in their words: "${p.fixedCommitments.trim()}". Plan around these.`,
    );
  }
  if (p.workDays) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    lines.push(`- Working days: ${p.workDays.map((d) => days[d]).join(', ') || 'none specified'}. Prefer these for work; ask before assuming other days are available for work.`);
  }
  if (p.focusPeriod) lines.push(`- Best focus period: ${p.focusPeriod}. Prefer it for demanding tasks, while respecting sleep and existing commitments.`);
  if (p.primaryGoal) lines.push(`- Main planning goal: ${p.primaryGoal}. Tailor suggestions to this goal.`);
  if (p.sleepQuality) lines.push(`- Self-reported sleep: ${p.sleepQuality}. Protect their chosen sleep window; offer practical routine suggestions when relevant, without diagnosis or promises.`);
  if (p.assistanceStyle) lines.push(`- Preferred help style: ${p.assistanceStyle}. Brief = direct answers; guided = one step or question at a time; proactive = one relevant optional suggestion, never unsolicited changes.`);
  lines.push('- The app detects arrival at meeting locations automatically (geofencing). If an event has a location, the user gets a heads-up on arrival. Encourage adding locations to events.');
  lines.push(`- Notifications respect the sleep window (${hour(p.sleepStartHour)}–${hour(p.sleepEndHour)}). Anything scheduled during sleep is pushed to wake time.`);
  return lines.join('\n');
}

export function buildSystemPrompt(input: {
  language: string;
  timezone: string;
  now: Date;
  userName?: string;
  snapshot: Snapshot;
  profile?: Profile;
  location?: DeviceLocation;
}): string {
  const languageName = LANGUAGE_NAMES[input.language] ?? 'English';
  const localNow = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(input.now);

  return [
    `You are ${input.userName ? `${input.userName}'s` : 'the user’s'} personal assistant.`,
    'You are a helpful, attentive personal assistant. Speak naturally, calmly and concretely.',
    '',
    'HOW YOU SPEAK:',
    `- ALWAYS answer in ${languageName}. This is the user's chosen language.`,
    '  Understand names and borrowed words in other languages without changing the reply language.',
    '- You are a woman. In any language that marks gender on verbs and',
    '  adjectives — Hebrew, Arabic, Spanish, French, Italian, Russian and the',
    '  like — always speak about yourself in the feminine.',
    '- In Hebrew, use fluent everyday Israeli Hebrew, correct word boundaries and grammar.',
    '  Avoid literal translations, stiff stock phrases, repeated greetings and unnecessary thanks.',
    '- Never say goodbye, "תודה רבה ביי", or end the conversation unless the user clearly ends it.',
    '  A completed task is not a goodbye. Silence or unclear audio is not a farewell.',
    '- Speech transcripts can contain spelling or spacing errors. Resolve obvious errors using',
    '  the request and conversation context. For example, in a shopping request "מיצנבים"',
    '  can mean "מיץ ענבים". If the intended item is ambiguous, ask one short clarification',
    '  BEFORE calling a mutation tool. Never silently substitute a different product or person.',
    '- Interpret follow-ups and corrections using the conversation. "No, grape juice" corrects',
    '  the previous item; it does not authorize unrelated changes or a second unwanted item.',
    '- Never invent prices, quantities, dates, transactions, weather or facts missing from the data.',
    '  Adding a shopping item does not mean it was purchased and does not create an expense.',
    '- Your answer is read aloud, so keep it to one or two short spoken sentences',
    '  on a single line. No line breaks.',
    '- Plain speech only: no markdown, no bullet points, no emoji, no lists of ids.',
    '  When the answer has structured content, use a visual tool instead of listing',
    '  everything out loud. Say a SHORT intro (max 15 words) and let the screen',
    '  carry the detail. Briefly confirm the important item or time aloud; read the details if asked.',
    '- Say times the way a person would ("tomorrow at four"), never as ISO timestamps.',
    '- In Hebrew and other languages where 24-hour digits are common on the',
    '  clock but not in speech, ALWAYS convert to the 12-hour spoken form with',
    '  the part of the day. "15:00" is "שלוש בצהריים", not "חמש עשרה"; "19:30"',
    '  is "שבע וחצי בערב", not "תשע עשרה שלושים"; "07:00" is "שבע בבוקר". The',
    '  parts of the day: בוקר (05-11), צהריים (12-14), אחר הצהריים (15-17),',
    '  ערב (18-21), לילה (22-04). Never read the clock as a two-digit number;',
    '  that is how a timetable talks, not a person.',
    '- Never tell the user to type, tap or open a form. Anything they ask for, you do.',
    '',
    'WHAT YOU DO:',
    '- NEVER answer a question about free time, gaps, availability or "when',
    '  could I" from the agenda below. The agenda cannot tell you those things.',
    '  Call find_free_time and answer from what it returns, every single time,',
    '  even when the agenda looks obvious to you. An entry there shows a start',
    '  time and nothing else: not how long it really runs, not the drive to the',
    '  next one, not that an evening is already spoken for. Answering without',
    '  calling it produces confident wrong times, which is worse than a pause.',
    '- Use the tools to create, change, complete and delete tasks and events.',
    '- Any question about free time, gaps, availability, or when something',
    '  could fit is answered with find_free_time — never by reading the agenda',
    '  and working it out yourself. The agenda does not show how long an entry',
    '  really takes, how long the drive between two of them is, or that an',
    '  evening is already spoken for; find_free_time knows all three.',
    '- Call it before proposing a time for anything, too. "When shall we do it?"',
    '  is a free-time question wearing a different hat.',
    '- An entry with no end time is not a moment. A meeting takes about an hour;',
    '  a wedding, a flight or a show takes an evening. Never treat the minute an',
    '  event starts as the minute someone is free again.',
    '- Use add_shopping_item when they mention something to buy — groceries,',
    '  household things. One call per item: three items is three calls.',
    '  Something already on the list (and not yet bought) is not added again —',
    '  say it is already there.',
    '- "I bought the milk" is check_shopping_item; "we don\'t need eggs any more"',
    '  is remove_shopping_item. "What do I need to buy?" is answered from the list.',
    '- Use add_money_entry when they say they earned, spent or paid something.',
    '  The amount is always positive; `kind` says which way it went.',
    '- "Dan owes me 200" or "I owe mum 50" is add_debt; "Dan paid me back" is',
    '  settle_debt. A mistaken income or expense is removed with delete_money_entry.',
    '- Questions about money — how much was spent, on what, against which',
    '  budget, how this month compares to last — are answered from the MONEY',
    '  section below, quoting its totals. Never sum the entries yourself.',
    '  For a this-month-vs-last-month answer, call spending_trends to get the',
    '  deltas computed and the recommendation written out. For "what\'s coming',
    '  up" or "can I afford X", call upcoming_debits to pull the standing',
    '  charges forward.',
    '- Calling the tool is the only thing that changes anything. Saying "I am',
    '  deleting it" or "I will add that" without a tool call in the same reply',
    '  changes nothing and is a broken promise — so when the user asks for a',
    '  change, call the tool right now, in this reply.',
    '- A request can need several tools at once. Call all of them.',
    '- MULTI-DOMAIN DUMPS: when the user runs several things together in one',
    '  breath — "tomorrow I need to call the doctor, buy dog food, send Or the',
    '  deck, book the car, pick up a package, and fit three workouts this',
    '  week" — do not pick one and ignore the rest, and do not ask them to',
    '  break it up. Split it yourself and call one tool per item in the same',
    '  reply: tasks go to create_task, things to buy to add_shopping_item,',
    '  anything with a set time to create_event, money that moved to',
    '  add_money_entry, debts to add_debt. A recurring goal like "three',
    '  workouts this week" is three create_task calls or three create_event',
    '  calls at times that fit, not a single vague note. After the calls,',
    '  summarise what landed where in one sentence, e.g. "I\'ve put the doctor',
    '  call, the car booking and the package pickup on tomorrow, dog food on',
    '  the shopping list, the deck as a task, and three workout slots across',
    '  the week." Use present_summary when the user clearly wants a',
    '  side-by-side.',
    '- Touch only what was asked for. Never rewrite an entry the user did not',
    '  mention, and never "tidy up" times or titles on your own.',
    '- Answering a question about the schedule needs no tool: the agenda is',
    '  below. Everything on it already exists — reading an entry out loud is',
    '  never a reason to create it.',
    '- Ids come only from the agenda below. Never invent one.',
    '- Act on an entry only when its title is clearly the one the user named.',
    '  If nothing in the agenda matches, say so — never fall back to the closest',
    '  entry, and never delete something they did not ask about.',
    '',
    'HOW YOU THINK (the Planzi standard):',
    '- THE SIGNATURE MOMENT: when the user has a free window, a known location,',
    '  and errands they could do nearby, make the connection out loud. Call',
    '  suggest_opportunity when: the user asks what they should do now; the',
    '  user opens a conversation with a clear gap on the schedule; a window is',
    '  freshly opened by a cancelled or early-ended event; the day has started',
    '  and errands remain. Shape the reply like this: "You have about 45 min',
    '  before Eliran — Shufersal is 2 minutes away and five items are waiting.',
    '  Want me to put it on the way?" Never read every item aloud; name one',
    '  or two. If the tool returns fit:null, do not invent a suggestion;',
    '  either stay quiet about this or say the day is clear.',
    '- LOOKING FORWARD WITH MONEY: never say "you spent X" without',
    '  context. Call spending_trends to show the direction of travel ("food',
    '  up 28% versus last month"), and call upcoming_debits whenever the user',
    '  asks about budget, affordability, how much is left, or what is coming',
    '  up. Quote the totals the tools return — never add figures yourself. A',
    '  real finance manager says "you have ₪2,300 showing, but ₪850 in standing',
    '  debits is due in the next two weeks — treat ₪1,450 as the useful',
    '  balance." You can and should say that kind of sentence.',
    '- RECOMMENDATIONS, NOT JUST REPORTS: when a trend climbs, pair it with',
    '  the saving the baseline implies ("going back to last month\'s average',
    '  on deliveries saves roughly ₪450"). When a debit cluster lands in one',
    '  week, name it ("three bills land the first week — keep more liquid'
      + ' through then"). The vision calls this a personal finance manager',
    '  rather than a tracker, so always finish with what the user can do.',
    '- DAY RE-PLANNING: when a task is overdue, when the user says the day',
    '  slipped ("I did not get to half of what I planned", "my day fell',
    '  apart"), or when a long event just ended on them, call replan_remainder',
    '  — it finds the next free windows across the coming days and returns a',
    '  specific proposal (which task to which slot). Pitch it as one sentence',
    '  ("I can move X to tomorrow at ten and Y to Wednesday — want me to?");',
    '  on yes, apply each proposal with update_task. When several errands sit',
    '  in the same area and the user is near there on a known day, offer to',
    '  cluster them. Short, concrete, one proposal.',
    '- BUDGET PRESSURE: before saying "you have N left in the budget", call',
    '  budget_alert — it projects spending to end of month at the current pace',
    '  and flags the category most at risk. The point is to warn the user',
    '  BEFORE they overrun, so a Planzi sentence sounds like "food is 78%',
    '  through with eleven days left — on pace to overshoot by about 240;',
    '  roughly 65 a day keeps it in budget." After the warning, offer one',
    '  option — slow down, reallocate, or accept it.',
    '- WEATHER-DRIVEN SUGGESTIONS: when the schedule has anything outdoors,',
    '  when the user asks about the weather, or when a plan would read',
    '  differently in rain, call check_weather. If rain is coming and an',
    '  outdoor errand is still on the list, offer to shift it earlier. Say',
    '  conditions in human speech ("hot and clear until the evening, then a',
    '  chance of rain"), never numbers only. Use present_weather for the',
    '  rendering.',
    '- BUNDLES, NOT ISOLATED ITEMS: hosting, lessons, courses, appointments',
    '  and travel are rarely one thing. "I\'m hosting twelve people on Friday"',
    '  is one event (create_event) plus a shopping list (one add_shopping_item',
    '  per thing to buy) plus a couple of prep tasks (create_task). Treat it',
    '  as a bundle in one reply.',
    '- SAYING WHAT YOU SEE: when a pattern is obvious — a day with five',
    '  back-to-back meetings, a category where spending doubled, a workout',
    '  that keeps getting missed — say it, briefly, before the user has to',
    '  ask. "Thursdays keep eating your workout — want to try Sunday instead?"',
    '  is a Planzi sentence; "I have moved it" is not.',
    '- EVENING CLOSE AND WEEKLY RECAP: when the user opens the app late (near',
    '  their sleep window) or asks "how did today go" or "how was my week",',
    '  that is a recap, not a to-do read. For today: call end_of_day — it',
    '  returns tasks done, what slipped, and tomorrow\'s first thing; lead with',
    '  a win, pair with replan_remainder on anything that slipped. For a week:',
    '  call weekly_summary and lead with one win, one biggest spend, and one',
    '  thing coming up. Never read a long list aloud — present_summary is the',
    '  surface. Never shame the user for unfinished tasks; the vision calls',
    '  this "no red to-do list of shame — just order and move on".',
    '- GOALS BECOME SLOTS: when the user says a count-per-week goal — "three',
    '  workouts this week", "I want to study four evenings", "call clients',
    '  twice a week" — call plan_recurring_goal, not create_task. It picks',
    '  real windows and spreads them across different days. Pitch the plan in',
    '  one line ("I found three 60-minute slots that fit — Sunday, Tuesday',
    '  evening, Thursday morning. Lock them in?"); on yes, call create_event',
    '  per proposed slot.',
    '- BATCHING BY AREA: when the user asks what the week looks like, when',
    '  they add a second thing in a city that already appears, or when they',
    '  ask if an errand can be grouped, call cluster_errands. If a cluster',
    '  comes back, offer the batch: "you have two things in Beer Sheva next',
    '  Tuesday and Thursday — want me to put Omer\'s visit on one of them?"',
    '  Encourage adding location to events so this works.',
    '- HOSTING, LESSONS, APPOINTMENTS AS BUNDLES: "I\'m hosting twelve on',
    '  Friday" or "I booked a piano lesson for Tuesday" is one event plus a',
    '  few prep tasks plus (for hosting) a shopping run. Issue all of them in',
    '  the same reply: create_event, then create_task for cleaning / set-up /',
    '  pre-work, then add_shopping_item per item. Hosting dinner for N scales:',
    '  mains, sides, drinks, bread, dessert, something to welcome them with.',
    '  Lesson or appointment: one event + reminders at useful times.',
    '- FREE TIME IS NOT WORK TIME: when the user has blocked time for family,',
    '  rest or themselves, respect it. Do not stuff an errand into dinner just',
    '  because the clock is open.',
    '- VISUAL TOOLS — use a visual tool for lists, comparisons and structured data.',
    '  A simple action only needs a natural spoken confirmation of what changed.',
    '  present_cards: options, recommendations, comparisons (set selectable when',
    '  they should pick one).',
    '  present_checklist: tasks OR shopping items — ALWAYS use this when the user',
    '  asks what they need to buy, what is on their list, or what tasks they have.',
    '  present_confirmation: after a successful change, if a visual confirmation is useful.',
    '  present_budget: spending, budgets, or expense breakdowns.',
    '  present_timeline: the day\'s schedule, what\'s coming up, or any time-ordered info.',
    '  present_debt: who owes whom.',
    '  present_actions: suggest 2–4 follow-up actions the user can tap.',
    '  present_weather: weather forecasts — always visual, not spoken.',
    '  present_summary: daily/weekly summaries with stats and highlights.',
    '  Keep speech concise without omitting the information the user asked to hear.',
    '- If several entries match what they said, ask which one — briefly.',
    '- If a request is missing a time you cannot reasonably guess, ask one short question.',
    '- After acting, say what you did in one sentence.',
    '- For anything about their schedule, answer from the agenda below.',
    '- The turn "[SESSION START]" is not something they said: they have just',
    '  opened you. Be proactive and personal:',
    '  1. Greet them by name. Give a short, insightful daily briefing: what is',
    '     coming up, how busy the day looks, anything that needs attention.',
    '  2. If tasks are overdue or piling up, mention it gently with encouragement.',
    '  3. If a free window is open now and the day has unfinished errands,',
    '     call suggest_opportunity and work the result into one sentence —',
    '     one place, one window, one offer.',
    '  4. If today has an outdoor-looking event (walk, outside meeting,',
    '     market, kids park), or if the user has frequently asked about',
    '     weather, call check_weather; if rain is coming and something is on,',
    '     flag it in one line.',
    '  5. If they completed a lot yesterday, acknowledge it ("you crushed it',
    '     yesterday — 8 tasks done!").',
    '  Keep it to 2–3 spoken sentences. Call no mutation tools for session start.',
    '- BE PROACTIVE throughout the conversation, not just at session start:',
    '  * After completing a task, suggest what to tackle next based on priority.',
    '  * If you notice patterns (e.g. they always add groceries on Thursdays),',
    '    mention it: "shopping day tomorrow — want me to check the list?".',
    '  * Offer small challenges: "you have 3 tasks left today — think you can',
    '    finish them all before 6?".',
    '  * When the day is winding down, offer a quick summary of what got done.',
    '  * Suggest breaks between back-to-back meetings.',
    '  The goal: feel like an assistant who truly knows them, not a command parser.',
    '- MEETING LIFECYCLE: be aware of the full arc of a meeting:',
    '  * Before: "Time to get ready for your meeting with X. Drive to Y is about 30 min."',
    '  * During: if they open you while a meeting is live, ask how it is going.',
    '  * After early end: "You finished early — you have 45 free minutes before',
    '    your next thing. Want to knock out that errand or just take a breather?"',
    '  * After a long day: "Your last few days were packed. Want me to help',
    '    clear some time for yourself?"',
    '- LANGUAGE TONE: never use robotic phrases like "you have free time from',
    '  15:00 to 23:00". Instead: "your evening is clear — perfect for catching',
    '  up on that show or getting ahead on tomorrow".',
    '  Never say "trip to client". Say "time to head out for your meeting with',
    '  Sami in Kfar Kana — about 30 minutes on the road".',
    '  Speak like a thoughtful friend, not a system notification.',
    '',
    `The user's local time is ${localNow} (${input.timezone}).`,
    'Resolve "tomorrow", "next Tuesday", "in an hour" against the calendar below,',
    'and give every time back as ISO-8601 with an explicit offset.',
    'When you move something to a named day, its date comes from this list — do',
    'not keep the entry on its old date and change only the time.',
    describeDays(input.now, input.timezone),
    '',
    ...(input.location
      ? [
          'CURRENT LOCATION:',
          `Coordinates: ${input.location.latitude.toFixed(4)}, ${input.location.longitude.toFixed(4)}`,
          ...(input.location.city ? [`City: ${input.location.city}`] : []),
          ...(input.location.country ? [`Country: ${input.location.country}`] : []),
          'Use this when the user asks about nearby places, directions, meeting spots, weather, or anything location-dependent.',
          'BE PROACTIVE about location: if the user has items on their shopping list and they are near a supermarket or mall, mention it. If they have errands that could be done nearby, suggest it. Use find_nearby and check_travel without being asked when the context makes it useful.',
          '',
        ]
      : []),
    ...(input.profile
      ? ['HOW THEIR WEEK IS SHAPED:', describeProfile(input.profile), '']
      : []),
    "THE USER'S CURRENT AGENDA:",
    describeSnapshot(input.snapshot, input.timezone),
    '',
    describeHousehold(input.snapshot, input.timezone, input.now),
  ].join('\n');
}

// ─── The turn ───────────────────────────────────────────────────────────────

export interface DeviceLocation {
  latitude: number;
  longitude: number;
  city?: string;
  country?: string;
}

export interface VoiceTurnInput {
  text: string;
  /** For the opening greeting only; every other turn mirrors the user. */
  language: string;
  timezone: string;
  now: Date;
  userName?: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  snapshot: Snapshot;
  /** Absent for an install that predates the questionnaire, or a skipped one. */
  profile?: Profile;
  /** The phone's current GPS position, when available. */
  location?: DeviceLocation;
}

export interface VoiceTurnResult {
  reply: string;
  actions: VoiceAction[];
  /**
   * Whether `find_free_time` was consulted this turn. Diagnostic: the whole
   * point of that tool is that she must not answer availability from the
   * agenda, and without this there is no way to tell a computed answer from a
   * confident guess that happens to look similar.
   */
  consultedFreeTime?: boolean;
}

/**
 * Rounds of tool calling before she must answer.
 *
 * Three, not two, because `find_free_time` costs a round that used to be spent
 * acting: ask when they are free, then book the thing, then say what happened.
 * At two, a turn that began with a free-time question had no round left to act
 * in, so she either skipped the question or skipped the booking.
 */
const MAX_ROUNDS = 3;

/**
 * How long one round may take before the turn is given up on.
 *
 * Tighter than the client-wide default in llm.ts, because this is the only
 * route where someone is sitting in silence waiting for an answer. Past about
 * this long they have already concluded it is broken and reached for the
 * button, so a request still running is no longer of any use to them —
 * failing at twenty-five seconds and saying so beats succeeding at ninety.
 * Two rounds means the worst case is bounded at roughly a minute rather than
 * at the several minutes the SDK's own retry-and-timeout defaults allow.
 */
const ROUND_TIMEOUT_MS = 25_000;

export async function runVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  const client = getOpenAI();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(input) },
    ...input.history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input.text },
  ];

  const actions: VoiceAction[] = [];
  let reply = '';
  /** Whether she actually consulted the calculator this turn. */
  let consulted = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const lastRound = round === MAX_ROUNDS - 1;
    const completion = await client.chat.completions.create(
      {
        model: config.OPENAI_VOICE_MODEL,
        messages,
        tools: ACTION_TOOLS,
        // On the final round she has already acted; all that is left is to say so.
        tool_choice: lastRound ? 'none' : 'auto',
        temperature: 0.3,
        max_completion_tokens: 2000,
      },
      // No retry: a second attempt at a request that has already spent the
      // user's patience arrives after they have stopped waiting for it, and
      // the client is better off being told the turn was lost.
      { timeout: ROUND_TIMEOUT_MS, maxRetries: 0 },
    );

    const message = completion.choices[0]?.message;
    if (!message) break;

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      reply = message.content?.trim() ?? '';
      break;
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== 'function') continue;
      const outcome = collectAction(
        call.function.name,
        call.function.arguments,
        input.snapshot,
        input.timezone,
      );

      // Asking when someone is free is a question, not a change. It is
      // answered here, into the conversation, and never reaches the device as
      // an action — there is nothing for the device to apply.
      if (outcome.action?.tool === 'find_nearby') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerNearbySearch(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'check_travel') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerTravelCheck(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'suggest_opportunity') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerSuggestOpportunity(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'check_weather') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerCheckWeather(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'plan_recurring_goal') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerPlanRecurringGoal(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'cluster_errands') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: answerClusterErrands(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'end_of_day') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: answerEndOfDay(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'replan_remainder') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerReplanRemainder(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'budget_alert') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: answerBudgetAlert(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'weekly_summary') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: answerWeeklySummary(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'spending_trends') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: answerSpendingTrends(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'upcoming_debits') {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: answerUpcomingDebits(outcome.action.arguments, input),
        });
        continue;
      }

      if (outcome.action?.tool === 'find_free_time') {
        logger.info(
          { args: outcome.action.arguments },
          'voice agent asked for free time',
        );
        consulted = true;
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: await answerFreeTime(outcome.action.arguments, input),
        });
        continue;
      }

      // A time that survives the gate still has to be a time the person can
      // keep. That check reaches a geocoder, so it cannot live inside
      // `collectAction`, which is synchronous and stays that way.
      const reviewed = outcome.action
        ? await reviewProposedTime(
            outcome.action,
            input.snapshot,
            input.timezone,
            input.now.getTime(),
            input.profile,
          )
        : null;

      if (reviewed) {
        actions.push(reviewed.action);
        messages.push({ role: 'tool', tool_call_id: call.id, content: reviewed.result });
        continue;
      }

      if (outcome.action) actions.push(outcome.action);
      // Every tool_call must be answered or the next request is rejected.
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: outcome.result,
      });
    }

    // Anything she said alongside the calls is a partial thought; the closing
    // sentence comes from the next round, once the results are in.
    reply = message.content?.trim() ?? reply;
  }

  return { reply, actions, consultedFreeTime: consulted };
}

/**
 * Answers "when am I free?" with computed windows.
 *
 * Everything the model would otherwise have to infer from the agenda text is
 * decided here instead: how long an event with no end time occupies, how much
 * of the gap before a meeting somewhere else is really travel, and whether an
 * evening has been taken over by something that ends the day.
 *
 * The result is deliberately shaped as prose-ready facts rather than raw
 * intervals. She is good at turning "until 12:40, because Shoham is 50 minutes
 * away" into a sentence, and bad at deriving that fact in the first place.
 */
async function answerFreeTime(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  const zone = input.timezone;
  const nowMs = input.now.getTime();
  const fromDate =
    typeof args.fromDate === 'string' ? args.fromDate : today(zone, nowMs);
  const eveningOnly = args.eveningOnly === true;

  const events: AvailabilityEvent[] = input.snapshot.events.map((e) => ({
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    location: e.location ?? null,
  }));

  const { days, skipped } = await findTime({
    fromDate,
    events,
    timeZone: zone,
    now: nowMs,
    prefs: input.profile
      ? {
          sleepStartHour: input.profile.sleepStartHour,
          sleepEndHour: input.profile.sleepEndHour,
          bufferMinutes: input.profile.bufferMinutes,
        }
      : undefined,
    eveningOnly,
    currentPosition: input.location
      ? { latitude: input.location.latitude, longitude: input.location.longitude }
      : undefined,
  });

  const needed =
    typeof args.minutesNeeded === 'number' && Number.isFinite(args.minutesNeeded)
      ? Math.round(args.minutesNeeded)
      : null;

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dayName = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const described = days.map((day) => ({
    date: day.date,
    day: dayName.format(new Date(`${day.date}T12:00:00Z`)),
    windows: day.windows
      // A window shorter than the job is not an answer, so it is not offered.
      .filter((w) => (needed === null ? true : w.minutes >= needed))
      .map((w) => ({
        from: clock.format(new Date(w.startsAt)),
        to: clock.format(new Date(w.endsAt)),
        minutes: w.minutes,
        endsBecause: w.endsBecause,
        ...(w.nextTitle ? { nextEvent: w.nextTitle } : {}),
        ...(w.nextPlace ? { nextPlace: w.nextPlace } : {}),
        ...(w.travelMinutes ? { travelMinutes: w.travelMinutes } : {}),
      })),
  }));

  return JSON.stringify({
    ok: true,
    askedFrom: fromDate,
    eveningOnly,
    days: described.filter((d) => d.windows.length > 0),
    skippedDays: skipped,
    instruction: [
      'These windows are already correct: durations, travel and blocked evenings are accounted for.',
      'Do not recalculate them from the agenda and do not widen them.',
      'When a window ends because of travel, say so and name the place — that is the useful part.',
      'When a day was skipped for eveningClosed, say that evening is taken by the event and give the next one that works.',
      'Give one or two windows in plain speech, not a list of every option.',
    ].join(' '),
  });
}

/**
 * Answers "how far is X from here?" using the phone's GPS and the geocoder.
 */
async function answerNearbySearch(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  const category = typeof args.category === 'string' ? args.category : '';
  if (!category) {
    return JSON.stringify({ ok: false, error: 'No category given.' });
  }

  if (!input.location) {
    return JSON.stringify({ ok: false, error: 'The user\'s location is not available. Ask them to enable location services.' });
  }

  const center = { latitude: input.location.latitude, longitude: input.location.longitude };
  const radius = typeof args.radiusMeters === 'number' ? args.radiusMeters : 3000;

  const places = await searchNearby(center, category, radius);

  if (places.length === 0) {
    return JSON.stringify({
      ok: true,
      places: [],
      note: `No ${category} places found within ${radius / 1000} km.`,
    });
  }

  return JSON.stringify({
    ok: true,
    places: places.map((p) => ({
      name: p.name,
      distanceKm: p.distanceKm,
    })),
    instruction: 'List the closest 3–4 places naturally, with approximate distance. Mention there are more if the list is longer.',
  });
}

async function answerTravelCheck(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  const destination = typeof args.destination === 'string' ? args.destination.trim() : '';
  if (!destination) {
    return JSON.stringify({ ok: false, error: 'No destination given.' });
  }

  if (!input.location) {
    return JSON.stringify({ ok: false, error: 'The user\'s location is not available. Ask them to enable location services.' });
  }

  const from = { latitude: input.location.latitude, longitude: input.location.longitude };
  const to = await geocode(destination);
  if (!to) {
    return JSON.stringify({ ok: false, error: `Could not find "${destination}" on the map.` });
  }

  const km = distanceKm(from, to);
  const mins = travelMinutes(km);

  return JSON.stringify({
    ok: true,
    from: input.location.city ?? `${from.latitude.toFixed(3)}, ${from.longitude.toFixed(3)}`,
    to: destination,
    distanceKm: Math.round(km),
    estimatedMinutes: mins,
    instruction: 'This is a minimum estimate (straight-line distance + fixed overhead). Real driving may take longer in traffic. Say the estimate naturally, e.g. "about 40 minutes from where you are".',
  });
}

/**
 * The signature moment: "you're near X, you have Y free, grab Z".
 *
 * Cross-references three sources the model has access to but never reliably
 * joins on its own: the live GPS position, today's actual free windows (via
 * findTime, which already subtracts travel and sleep), and the shopping list.
 *
 * Returns one candidate suggestion or null. Returning two gives the model room
 * to pick the less-useful one; returning none is better than inventing one.
 */
export async function answerSuggestOpportunity(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  const minWindow =
    typeof args.minWindowMinutes === 'number' && args.minWindowMinutes > 0
      ? Math.round(args.minWindowMinutes)
      : 20;

  if (!input.location) {
    return JSON.stringify({
      ok: true,
      fit: null,
      note: 'No GPS yet, so a nearby-plus-free-window suggestion cannot be made. Say so in passing if the user asked what to do now.',
    });
  }

  const zone = input.timezone;
  const nowMs = input.now.getTime();
  const fromDate = today(zone, nowMs);

  const events: AvailabilityEvent[] = input.snapshot.events.map((e) => ({
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    location: e.location ?? null,
  }));

  const { days } = await findTime({
    fromDate,
    events,
    timeZone: zone,
    now: nowMs,
    prefs: input.profile
      ? {
          sleepStartHour: input.profile.sleepStartHour,
          sleepEndHour: input.profile.sleepEndHour,
          bufferMinutes: input.profile.bufferMinutes,
        }
      : undefined,
    wantDays: 1,
    searchDays: 1,
    currentPosition: { latitude: input.location.latitude, longitude: input.location.longitude },
  });

  const todayWindows = days[0]?.windows ?? [];
  // The "current" window is the first one whose end is still ahead of us.
  const currentWindow = todayWindows.find(
    (w) => new Date(w.endsAt).getTime() > nowMs && w.minutes >= minWindow,
  );

  if (!currentWindow) {
    return JSON.stringify({
      ok: true,
      fit: null,
      note:
        todayWindows.length === 0
          ? 'The day has no free window left. Say the day is packed and offer to look at tomorrow.'
          : `No window of at least ${minWindow} min is open right now. Mention the next one if asked.`,
    });
  }

  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const windowText = `until ${clock.format(new Date(currentWindow.endsAt))}, about ${currentWindow.minutes} minutes`;

  // Shopping that's a short detour from where they stand is the strongest fit:
  // one place, many items, no scheduling.
  const openShopping = input.snapshot.shopping.filter((s) => !s.isBought);
  if (openShopping.length > 0 && currentWindow.minutes >= 25) {
    const here = { latitude: input.location.latitude, longitude: input.location.longitude };
    // Grocery first, then general shopping — matches how the list is written.
    const market = (await searchNearby(here, 'supermarket', 2500))[0]
      ?? (await searchNearby(here, 'shopping', 2500))[0];
    if (market) {
      const roundTripMin = travelMinutes(market.distanceKm) * 2;
      const buffer = input.profile?.bufferMinutes ?? 15;
      // In-store time: a few minutes per item, floored and capped — a 2-item
      // run isn't 6 minutes and a 20-item run isn't 60.
      const inStoreMin = Math.max(10, Math.min(35, openShopping.length * 3));
      const totalMin = roundTripMin + inStoreMin;
      if (totalMin + buffer <= currentWindow.minutes) {
        return JSON.stringify({
          ok: true,
          fit: {
            kind: 'shopping_detour',
            window: windowText,
            windowMinutes: currentWindow.minutes,
            nextEvent: currentWindow.nextTitle ?? null,
            place: { name: market.name, distanceKm: Math.round(market.distanceKm * 10) / 10 },
            items: openShopping.slice(0, 5).map((s) => s.name),
            itemCount: openShopping.length,
            estimatedMinutes: totalMin,
          },
          instruction:
            'Make one short, specific offer. Name the place, say roughly how long it will take, and name one or two items from the list. Example shape: "You have about 45 min before Eliran; Shufersal is 2 minutes away and you have 5 things on the list — want to go now?" Do not list every item.',
        });
      }
    }
  }

  // Overdue tasks: use the free window to clear something that was due before now.
  const overdue = input.snapshot.tasks.filter((t) => {
    if (t.isDone) return false;
    if (!t.dueAt) return false;
    const due = new Date(t.dueAt).getTime();
    return Number.isFinite(due) && due < nowMs;
  });
  if (overdue.length > 0) {
    return JSON.stringify({
      ok: true,
      fit: {
        kind: 'clear_overdue',
        window: windowText,
        windowMinutes: currentWindow.minutes,
        nextEvent: currentWindow.nextTitle ?? null,
        tasks: overdue.slice(0, 3).map((t) => ({ id: t.id, title: t.title })),
        overdueCount: overdue.length,
      },
      instruction:
        'Suggest clearing one specific overdue task in this window — name it. Keep it one sentence; do not read the full list.',
    });
  }

  // Fallback: real quiet. Offer a focus block or a breather.
  return JSON.stringify({
    ok: true,
    fit: {
      kind: 'quiet_window',
      window: windowText,
      windowMinutes: currentWindow.minutes,
      nextEvent: currentWindow.nextTitle ?? null,
    },
    instruction:
      'No concrete errand fits. Say the window is clear and offer two options briefly: get ahead on something, or just take a breather. Do not invent an errand.',
  });
}

/**
 * "Deliveries up 28% versus last month" — spending trends, computed, so the
 * model never sums figures itself.
 */
export function answerSpendingTrends(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): string {
  const minPct =
    typeof args.minPercent === 'number' && args.minPercent > 0 ? args.minPercent : 15;
  const cur = input.snapshot.currency ? ` ${input.snapshot.currency}` : '';
  const amt = (n: number) => `${Math.round(n * 100) / 100}${cur}`;

  const thisMonth = monthOf(input.now, input.timezone);
  const lastMonth = monthOf(input.now, input.timezone, 1);

  const byCat = (month: string) => {
    const totals = new Map<string, number>();
    for (const r of input.snapshot.money) {
      if (r.kind !== 'expense') continue;
      if (!r.date.startsWith(month)) continue;
      const key = r.category ?? 'uncategorised';
      totals.set(key, (totals.get(key) ?? 0) + r.amount);
    }
    return totals;
  };

  const now = byCat(thisMonth);
  const prev = byCat(lastMonth);

  if (now.size === 0 && prev.size === 0) {
    return JSON.stringify({
      ok: true,
      findings: [],
      note: 'No spending recorded for either month yet. Say so plainly.',
    });
  }

  // Only categories where the climb is meaningful both in percent AND money:
  // a 50% jump from ₪10 to ₪15 is noise.
  const findings: Array<{
    category: string;
    thisMonth: number;
    lastMonth: number;
    delta: number;
    deltaPct: number;
  }> = [];

  const categories = new Set([...now.keys(), ...prev.keys()]);
  for (const cat of categories) {
    const nowAmt = now.get(cat) ?? 0;
    const prevAmt = prev.get(cat) ?? 0;
    const delta = nowAmt - prevAmt;
    if (prevAmt === 0) {
      // New category this month: worth mentioning once it crosses a floor.
      if (nowAmt >= 100) {
        findings.push({ category: cat, thisMonth: nowAmt, lastMonth: 0, delta, deltaPct: Infinity });
      }
      continue;
    }
    const deltaPct = (delta / prevAmt) * 100;
    if (deltaPct >= minPct && delta >= 50) {
      findings.push({ category: cat, thisMonth: nowAmt, lastMonth: prevAmt, delta, deltaPct });
    }
  }

  findings.sort((a, b) => b.delta - a.delta);

  // Also compute the biggest savings: categories where spending dropped — the
  // vision also wants the assistant to acknowledge wins, not only warn.
  const savings: typeof findings = [];
  for (const cat of categories) {
    const nowAmt = now.get(cat) ?? 0;
    const prevAmt = prev.get(cat) ?? 0;
    if (prevAmt === 0) continue;
    const delta = nowAmt - prevAmt;
    const deltaPct = (delta / prevAmt) * 100;
    if (deltaPct <= -minPct && -delta >= 50) {
      savings.push({ category: cat, thisMonth: nowAmt, lastMonth: prevAmt, delta, deltaPct });
    }
  }
  savings.sort((a, b) => a.delta - b.delta);

  return JSON.stringify({
    ok: true,
    thisMonth: { month: thisMonth, total: [...now.values()].reduce((s, v) => s + v, 0) },
    lastMonth: { month: lastMonth, total: [...prev.values()].reduce((s, v) => s + v, 0) },
    climbing: findings.slice(0, 3).map((f) => ({
      category: f.category,
      thisMonth: amt(f.thisMonth),
      lastMonth: f.lastMonth === 0 ? 'none' : amt(f.lastMonth),
      change: `${f.deltaPct === Infinity ? 'new' : `+${Math.round(f.deltaPct)}%`}`,
      extraSpend: amt(f.delta),
      recommendation:
        f.lastMonth > 0
          ? `Returning to the ${amt(f.lastMonth)} baseline saves roughly ${amt(f.delta)} per month.`
          : null,
    })),
    improving: savings.slice(0, 2).map((f) => ({
      category: f.category,
      thisMonth: amt(f.thisMonth),
      lastMonth: amt(f.lastMonth),
      change: `${Math.round(f.deltaPct)}%`,
      saved: amt(-f.delta),
    })),
    instruction:
      findings.length === 0 && savings.length === 0
        ? 'Nothing climbed meaningfully. Say spending looks steady and leave it at that.'
        : 'Pick the single most useful line. Name the category, say the change in plain speech ("deliveries, up by about a third"), and give the saving the recommendation points to. One sentence. Prefer present_budget to show the detail, do not read all numbers aloud.',
  });
}

/**
 * Project recurring debits forward: "₪850 of standing charges in the next 30
 * days". Finds expense descriptions that repeated across months, estimates the
 * next hit from the day-of-month pattern, and totals them.
 */
export function answerUpcomingDebits(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): string {
  const horizon =
    typeof args.horizonDays === 'number' && args.horizonDays > 0
      ? Math.min(90, Math.round(args.horizonDays))
      : 30;
  const cur = input.snapshot.currency ? ` ${input.snapshot.currency}` : '';
  const amt = (n: number) => `${Math.round(n * 100) / 100}${cur}`;

  const expenses = input.snapshot.money
    .filter((m) => m.kind === 'expense')
    .filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date));

  if (expenses.length === 0) {
    return JSON.stringify({
      ok: true,
      upcoming: [],
      note: 'No expense history to project from. Say so briefly if the user asked.',
    });
  }

  // Group by normalized description (and category when present): "Spotify" and
  // "spotify" are the same subscription, but "Spotify" and "Netflix" are not.
  type Row = typeof expenses[number];
  const key = (r: Row) => `${(r.category ?? '').toLowerCase()}|${normalizeTitle(r.description)}`;
  const groups = new Map<string, Row[]>();
  for (const r of expenses) {
    const k = key(r);
    const existing = groups.get(k);
    if (existing) existing.push(r);
    else groups.set(k, [r]);
  }

  const nowMs = input.now.getTime();
  const horizonMs = nowMs + horizon * 24 * 60 * 60 * 1000;

  const upcoming: Array<{
    description: string;
    amount: number;
    expectedDate: string;
    seenMonths: number;
    category: string | null;
  }> = [];

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;

    // Distinct months seen — a monthly charge appears in distinct months, a
    // single-month flurry does not.
    const months = new Set(rows.map((r) => r.date.slice(0, 7)));
    if (months.size < 2) continue;

    // Average amount, rounded to the nearest shekel: a subscription varies a
    // little from month to month (currency rounding), but not wildly.
    const avg = rows.reduce((s, r) => s + r.amount, 0) / rows.length;

    // Typical day of month — use the latest sample as the forecast anchor.
    const latest = rows.reduce((a, b) => (a.date > b.date ? a : b));
    const [, , dayStr] = latest.date.split('-');
    const day = Number(dayStr);

    // Project the next due date: this month's same day if still ahead, else
    // next month's same day. Repeat until we leave the horizon.
    const [nowY, nowM, nowD] = (today(input.timezone, nowMs)).split('-').map(Number);
    let y = nowY!;
    let m = nowM!;
    // If the day has already passed this month, start from next month.
    if (day < nowD!) {
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    const expectedDate = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const expectedMs = new Date(`${expectedDate}T12:00:00Z`).getTime();
    if (expectedMs > horizonMs) continue;

    upcoming.push({
      description: latest.description,
      amount: Math.round(avg * 100) / 100,
      expectedDate,
      seenMonths: months.size,
      category: latest.category ?? null,
    });
  }

  upcoming.sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));

  const total = upcoming.reduce((s, u) => s + u.amount, 0);

  return JSON.stringify({
    ok: true,
    horizonDays: horizon,
    upcoming: upcoming.map((u) => ({ ...u, amount: amt(u.amount) })),
    totalExpected: amt(total),
    note:
      upcoming.length === 0
        ? 'No recurring charges detected in the horizon. Say so plainly.'
        : `Over the next ${horizon} days, roughly ${amt(total)} of standing charges are expected. Say the total and name the biggest one or two. Do not read every entry — use present_summary or present_cards if more detail is useful.`,
  });
}

/**
 * Fetch weather from Open-Meteo. No API key, no account, free for the volumes
 * this app will ever see. The result is deliberately small: current reading
 * plus a next-24h precipitation picture, so the model can decide whether an
 * outdoor plan needs moving without wading through a full forecast.
 */
export async function answerCheckWeather(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  if (!input.location) {
    return JSON.stringify({
      ok: false,
      error: 'No location yet. Ask the user to enable location services, or ask for the city.',
    });
  }

  const days = Math.max(
    1,
    Math.min(7, typeof args.days === 'number' && args.days > 0 ? Math.round(args.days) : 2),
  );
  const { latitude, longitude } = input.location;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}` +
    `&current=temperature_2m,precipitation,weather_code,wind_speed_10m` +
    `&hourly=temperature_2m,precipitation_probability,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max` +
    `&forecast_days=${days}&timezone=auto`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return JSON.stringify({
        ok: false,
        error: 'Weather lookup failed. Carry on without it; do not invent conditions.',
      });
    }

    const data = (await res.json()) as {
      current?: { temperature_2m: number; precipitation: number; weather_code: number; wind_speed_10m: number };
      hourly?: {
        time: string[];
        temperature_2m: number[];
        precipitation_probability: number[];
        weather_code: number[];
      };
      daily?: {
        time: string[];
        weather_code: number[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_sum: number[];
        precipitation_probability_max: number[];
      };
    };

    // Peek the next 12 hours' precipitation probability — if any slot is high,
    // the model should know when to warn the user.
    const nowMs = input.now.getTime();
    const next12 = (data.hourly?.time ?? [])
      .map((t, i) => ({
        hour: t,
        ms: new Date(t).getTime(),
        tempC: data.hourly!.temperature_2m[i],
        pop: data.hourly!.precipitation_probability[i] ?? 0,
        code: data.hourly!.weather_code[i] ?? 0,
      }))
      .filter((h) => h.ms >= nowMs && h.ms <= nowMs + 12 * 60 * 60 * 1000);

    const peakPop = next12.reduce((max, h) => (h.pop > max.pop ? h : max), { pop: -1 } as typeof next12[number]);
    const willRain = peakPop && peakPop.pop >= 50;

    return JSON.stringify({
      ok: true,
      now: data.current
        ? {
            tempC: Math.round(data.current.temperature_2m),
            precipitation: data.current.precipitation,
            windKmh: Math.round(data.current.wind_speed_10m),
            code: data.current.weather_code,
            summary: weatherCodeLabel(data.current.weather_code),
          }
        : null,
      next12h: next12.slice(0, 6).map((h) => ({
        hour: h.hour.slice(11, 16),
        tempC: Math.round(h.tempC ?? 0),
        rainPct: h.pop,
        summary: weatherCodeLabel(h.code),
      })),
      days: (data.daily?.time ?? []).map((d, i) => ({
        date: d,
        high: Math.round(data.daily!.temperature_2m_max[i] ?? 0),
        low: Math.round(data.daily!.temperature_2m_min[i] ?? 0),
        rainPct: data.daily!.precipitation_probability_max[i] ?? 0,
        summary: weatherCodeLabel(data.daily!.weather_code[i] ?? 0),
      })),
      ...(willRain
        ? {
            rainWindow: {
              startsAtHour: peakPop.hour.slice(11, 16),
              peakRainPct: peakPop.pop,
              instruction:
                'Rain is likely in the next few hours. If an outdoor errand is on the schedule, offer to move it earlier.',
            },
          }
        : {}),
      instruction:
        'Use present_weather for the forecast rendering. Say conditions naturally ("hot and clear until the evening, then a chance of rain"), not with raw numbers.',
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'open-meteo lookup failed');
    return JSON.stringify({
      ok: false,
      error: 'Weather lookup failed. Carry on without it.',
    });
  }
}

/**
 * Map an Open-Meteo WMO code to one of the eight visual icons present_weather
 * already uses. Not a full weather report — the point is a label the model can
 * echo in plain speech.
 */
function weatherCodeLabel(code: number): string {
  if (code === 0) return 'sun';
  if (code <= 2) return 'partly_cloudy';
  if (code === 3) return 'cloud';
  if (code >= 45 && code <= 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain';
  if (code >= 85 && code <= 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}

/**
 * Day fell apart — redistribute what did not get done.
 *
 * Finds overdue tasks (dueAt in the past, isDone false) and tasks dated for
 * today that are still open as the day runs out. For each, searches the next
 * few days' free windows and proposes a specific new slot. The model turns
 * the plan into one short pitch; a yes from the user becomes update_task calls.
 */
export async function answerReplanRemainder(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  const lookAhead = Math.max(
    1,
    Math.min(
      7,
      typeof args.lookAheadDays === 'number' && args.lookAheadDays > 0
        ? Math.round(args.lookAheadDays)
        : 3,
    ),
  );

  const nowMs = input.now.getTime();
  const zone = input.timezone;
  const todayStr = today(zone, nowMs);

  const stranded = input.snapshot.tasks.filter((t) => {
    if (t.isDone) return false;
    if (!t.dueAt) return false;
    const due = new Date(t.dueAt).getTime();
    if (!Number.isFinite(due)) return false;
    // Overdue, OR due today and the day is more than 60% through.
    if (due < nowMs) return true;
    const dueDay = dayOf(t.dueAt, zone);
    if (dueDay === todayStr) {
      const [hStr, mStr] = (new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(input.now)).split(':');
      const minutesSinceMidnight = Number(hStr) * 60 + Number(mStr);
      return minutesSinceMidnight >= 18 * 60;
    }
    return false;
  });

  if (stranded.length === 0) {
    return JSON.stringify({
      ok: true,
      stranded: [],
      note: 'Nothing is actually stranded. Say the day is on track; do not invent moves.',
    });
  }

  const events: AvailabilityEvent[] = input.snapshot.events.map((e) => ({
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    location: e.location ?? null,
  }));

  // Start the search from tomorrow — today is where they slipped.
  const tomorrowMs = nowMs + 24 * 60 * 60 * 1000;
  const fromDate = today(zone, tomorrowMs);

  const { days } = await findTime({
    fromDate,
    events,
    timeZone: zone,
    now: nowMs,
    prefs: input.profile
      ? {
          sleepStartHour: input.profile.sleepStartHour,
          sleepEndHour: input.profile.sleepEndHour,
          bufferMinutes: input.profile.bufferMinutes,
        }
      : undefined,
    wantDays: lookAhead,
    searchDays: lookAhead,
  });

  // Flatten the first few windows across the forecasted days — each task
  // claims one, 30-minute minimum, in order.
  const windows = days.flatMap((d) =>
    d.windows.filter((w) => w.minutes >= 30).map((w) => ({ date: d.date, ...w })),
  );

  if (windows.length === 0) {
    return JSON.stringify({
      ok: true,
      stranded: stranded.map((t) => ({ id: t.id, title: t.title })),
      proposals: [],
      note:
        'There are no 30-minute windows across the next few days. Say the next days are packed and ask the user how they want to triage.',
    });
  }

  const proposals = stranded.slice(0, 5).map((task, i) => {
    const w = windows[i % windows.length]!;
    return {
      taskId: task.id,
      title: task.title,
      newDueAt: w.startsAt,
      day: w.date,
      windowMinutes: w.minutes,
      reasonTail: w.nextTitle ? `before ${w.nextTitle}` : null,
    };
  });

  return JSON.stringify({
    ok: true,
    strandedCount: stranded.length,
    proposals,
    instruction:
      'Make ONE short pitch summarising the plan: "I can move X to tomorrow at 10, Y to Wednesday morning — want me to?" Do not list every move at length. On yes, call update_task per proposal with the newDueAt. Use present_summary if a visual confirmation is useful.',
  });
}

/**
 * Warn before overrun, not after. For each category budget, projects spending
 * forward from the current pace through the end of the month and flags the ones
 * likely to overshoot.
 */
export function answerBudgetAlert(
  _args: Record<string, unknown>,
  input: VoiceTurnInput,
): string {
  const cur = input.snapshot.currency ? ` ${input.snapshot.currency}` : '';
  const amt = (n: number) => `${Math.round(n * 100) / 100}${cur}`;

  const budgets = input.snapshot.budgets ?? {};
  if (Object.keys(budgets).length === 0) {
    return JSON.stringify({
      ok: true,
      findings: [],
      note:
        'No budgets have been set. If the user asked, suggest briefly that setting a budget per category unlocks pacing warnings — do not nag.',
    });
  }

  // Determine how far into the month we are, in the user's zone.
  const todayStr = today(input.timezone, input.now.getTime());
  const [, , dStr] = todayStr.split('-');
  const dayOfMonth = Number(dStr);

  // Days in the current month, in the user's zone. Build YYYY-MM-DD for day 28,
  // then step forward until the month flips.
  const [yStr, mStr] = todayStr.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(); // last day
  const daysLeft = Math.max(1, daysInMonth - dayOfMonth);
  const monthProgress = dayOfMonth / daysInMonth;

  const thisMonth = `${yStr}-${mStr}`;
  const spentByCat = new Map<string, number>();
  for (const r of input.snapshot.money) {
    if (r.kind !== 'expense') continue;
    if (!r.date.startsWith(thisMonth)) continue;
    const key = r.category ?? 'uncategorised';
    spentByCat.set(key, (spentByCat.get(key) ?? 0) + r.amount);
  }

  const findings: Array<{
    category: string;
    limit: number;
    spent: number;
    pct: number;
    projected: number;
    overshoot: number;
    daysLeft: number;
    severity: 'overrun' | 'risk' | 'ok';
  }> = [];

  for (const [cat, limit] of Object.entries(budgets)) {
    if (!(limit > 0)) continue;
    const spent = spentByCat.get(cat) ?? 0;
    const pct = spent / limit;
    // Pace projection: if we're a third into the month and already at a third,
    // we're on track. If we're a third in and at 60%, we project to 180% —
    // overshoot by 80%.
    const projected = monthProgress > 0 ? spent / monthProgress : spent;
    const overshoot = Math.max(0, projected - limit);

    let severity: 'overrun' | 'risk' | 'ok' = 'ok';
    if (spent >= limit) severity = 'overrun';
    else if (overshoot > 0 && projected > limit * 1.1) severity = 'risk';
    else if (pct >= 0.9) severity = 'risk';

    if (severity === 'ok') continue;
    findings.push({ category: cat, limit, spent, pct: pct * 100, projected, overshoot, daysLeft, severity });
  }

  // Overrun first, then biggest projected overshoot.
  findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'overrun' ? -1 : 1;
    return b.overshoot - a.overshoot;
  });

  return JSON.stringify({
    ok: true,
    monthProgress: Math.round(monthProgress * 100),
    daysLeft,
    findings: findings.slice(0, 3).map((f) => ({
      category: f.category,
      budget: amt(f.limit),
      spent: amt(f.spent),
      pct: Math.round(f.pct),
      projected: amt(Math.round(f.projected)),
      overshootBy: f.overshoot > 0 ? amt(Math.round(f.overshoot)) : null,
      daysLeft: f.daysLeft,
      severity: f.severity,
      recommendation:
        f.severity === 'overrun'
          ? `Already over the ${amt(f.limit)} budget. Reset, reallocate from another category, or accept it — say which once.`
          : `On pace to overshoot by about ${amt(Math.round(f.overshoot))}. ${amt(Math.round((f.limit - f.spent) / Math.max(1, f.daysLeft)))} per day keeps it in budget.`,
    })),
    instruction:
      findings.length === 0
        ? 'All budgets are on track. Say so briefly and leave it at that.'
        : 'Lead with the single worst category. Say the number plainly ("food is 78 percent through with 11 days left — on pace to overshoot by about 240"), then give one concrete option. Use present_budget to render the detail.',
  });
}

/**
 * Weekly recap: what shifted this week, in numbers the model can quote without
 * doing arithmetic. Zone-aware week bounds — Sunday is day 0 (Israel/US).
 */
export function answerWeeklySummary(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): string {
  const cur = input.snapshot.currency ? ` ${input.snapshot.currency}` : '';
  const amt = (n: number) => `${Math.round(n * 100) / 100}${cur}`;
  const weeksBack = Math.max(
    0,
    Math.min(4, typeof args.weeksBack === 'number' ? Math.round(args.weeksBack) : 0),
  );

  // Find the Sunday that opens the week we care about, in the user's zone.
  const zone = input.timezone;
  const nowMs = input.now.getTime();
  const todayStr = today(zone, nowMs);
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayDate = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = todayDate.getUTCDay(); // 0 = Sunday
  const sundayMs = todayDate.getTime() - dow * 24 * 60 * 60 * 1000 - weeksBack * 7 * 24 * 60 * 60 * 1000;
  const sunday = new Date(sundayMs);
  const saturday = new Date(sundayMs + 6 * 24 * 60 * 60 * 1000);

  const isoDate = (date: Date) =>
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  const weekStart = isoDate(sunday);
  const weekEnd = isoDate(saturday);

  // Money in and out this week.
  const weekMoney = input.snapshot.money.filter((r) => r.date >= weekStart && r.date <= weekEnd);
  const income = weekMoney.filter((r) => r.kind === 'income').reduce((s, r) => s + r.amount, 0);
  const spent = weekMoney.filter((r) => r.kind === 'expense').reduce((s, r) => s + r.amount, 0);

  const byCat = new Map<string, number>();
  for (const r of weekMoney) {
    if (r.kind !== 'expense') continue;
    const key = r.category ?? 'uncategorised';
    byCat.set(key, (byCat.get(key) ?? 0) + r.amount);
  }
  const biggestCat = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

  // Tasks finished this week (dueAt within the window AND isDone).
  // The snapshot's isDone only tells us current state, not when it finished,
  // so this is an approximation: a done task whose due date is this week.
  const tasksDoneThisWeek = input.snapshot.tasks.filter(
    (t) => t.isDone && t.dueAt && dayOf(t.dueAt, zone)! >= weekStart && dayOf(t.dueAt, zone)! <= weekEnd,
  );
  const tasksOpenThisWeek = input.snapshot.tasks.filter(
    (t) => !t.isDone && t.dueAt && dayOf(t.dueAt, zone)! >= weekStart && dayOf(t.dueAt, zone)! <= weekEnd,
  );

  // Which days were packed: count events per day.
  const eventsPerDay = new Map<string, number>();
  for (const e of input.snapshot.events) {
    const day = dayOf(e.startsAt, zone);
    if (!day || day < weekStart || day > weekEnd) continue;
    eventsPerDay.set(day, (eventsPerDay.get(day) ?? 0) + 1);
  }
  const packedDays = [...eventsPerDay.entries()]
    .filter(([, n]) => n >= 4)
    .map(([date]) => date);

  // Upcoming week preview — next 7 days of events.
  const upcoming = input.snapshot.events
    .filter((e) => {
      const t = new Date(e.startsAt).getTime();
      return t >= nowMs && t <= nowMs + 7 * 24 * 60 * 60 * 1000;
    })
    .slice(0, 5)
    .map((e) => ({ title: e.title, startsAt: e.startsAt, location: e.location ?? null }));

  return JSON.stringify({
    ok: true,
    weekStart,
    weekEnd,
    money: {
      income: amt(income),
      spent: amt(spent),
      balance: amt(income - spent),
      biggestCategory: biggestCat
        ? { name: biggestCat[0], amount: amt(biggestCat[1]) }
        : null,
    },
    tasks: {
      finished: tasksDoneThisWeek.length,
      stillOpen: tasksOpenThisWeek.length,
    },
    packedDays,
    upcoming,
    instruction:
      'Hand the user a short recap: one line of what happened, one line of what is ahead. ' +
      'Celebrate wins ("you knocked out 12 tasks this week"), name the biggest spend, name tomorrow or Monday if it stands out. ' +
      'Use present_summary for the numbers; do not read every figure aloud.',
  });
}

/**
 * "Three workouts this week" → three concrete, non-adjacent calendar slots.
 *
 * Picks windows from the next 7 days that each hold the requested duration,
 * spread apart so the user does not land three workouts on three consecutive
 * days. Returns the proposal; the agent asks the user to confirm, then creates
 * events for each slot.
 */
export async function answerPlanRecurringGoal(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): Promise<string> {
  const title = String(args.title ?? '').trim();
  const timesPerWeek = Math.max(
    1,
    Math.min(7, Math.round(Number(args.timesPerWeek) || 1)),
  );
  const duration = Math.max(
    15,
    Math.min(
      8 * 60,
      typeof args.durationMinutes === 'number' && args.durationMinutes > 0
        ? Math.round(args.durationMinutes)
        : 60,
    ),
  );
  const period = ((args.preferredPeriod as string | undefined) ?? 'any') as
    | 'morning'
    | 'afternoon'
    | 'evening'
    | 'any';

  if (!title) {
    return JSON.stringify({ ok: false, error: 'No title given.' });
  }

  const zone = input.timezone;
  const nowMs = input.now.getTime();
  const fromDate = today(zone, nowMs);

  const events: AvailabilityEvent[] = input.snapshot.events.map((e) => ({
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    location: e.location ?? null,
  }));

  const { days } = await findTime({
    fromDate,
    events,
    timeZone: zone,
    now: nowMs,
    prefs: input.profile
      ? {
          sleepStartHour: input.profile.sleepStartHour,
          sleepEndHour: input.profile.sleepEndHour,
          bufferMinutes: input.profile.bufferMinutes,
        }
      : undefined,
    wantDays: 7,
    searchDays: 7,
  });

  // Flatten and filter by duration + preferred period.
  const hourFromIso = (iso: string): number => {
    const h = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      hour12: false,
    }).format(new Date(iso));
    return Number(h);
  };
  const inPeriod = (h: number): boolean => {
    if (period === 'any') return true;
    if (period === 'morning') return h >= 6 && h < 12;
    if (period === 'afternoon') return h >= 12 && h < 17;
    return h >= 17 && h < 22;
  };

  const slots = days.flatMap((d) =>
    d.windows
      .filter((w) => w.minutes >= duration)
      .filter((w) => inPeriod(hourFromIso(w.startsAt)))
      .map((w) => ({ date: d.date, startsAt: w.startsAt, windowMinutes: w.minutes })),
  );

  if (slots.length === 0) {
    return JSON.stringify({
      ok: true,
      proposed: [],
      note:
        period === 'any'
          ? `No ${duration}-minute windows found in the next 7 days. Say the week is packed and ask the user how to make room.`
          : `No ${duration}-minute windows in the ${period} slot across the next 7 days. Ask if another time of day works.`,
    });
  }

  // Spread: pick one slot per day, preferring different days before doubling up.
  const picked: typeof slots = [];
  const usedDates = new Set<string>();
  for (const s of slots) {
    if (picked.length >= timesPerWeek) break;
    if (usedDates.has(s.date)) continue;
    picked.push(s);
    usedDates.add(s.date);
  }
  // If still short, allow a second slot on days that already have one, but
  // only when we really need the count. This happens on weeks with few free
  // days — better two on Tuesday than silently skipping the goal.
  if (picked.length < timesPerWeek) {
    for (const s of slots) {
      if (picked.length >= timesPerWeek) break;
      if (picked.some((p) => p.startsAt === s.startsAt)) continue;
      picked.push(s);
    }
  }

  const proposed = picked.map((s) => ({
    title,
    startsAt: s.startsAt,
    durationMinutes: duration,
    windowMinutes: s.windowMinutes,
    date: s.date,
  }));

  return JSON.stringify({
    ok: true,
    goalTitle: title,
    timesPerWeekRequested: timesPerWeek,
    foundCount: proposed.length,
    proposed,
    instruction:
      proposed.length < timesPerWeek
        ? `Only ${proposed.length} ${duration}-min slots fit this week. Say so and ask whether to go with the fewer or push to next week — do NOT silently drop any.`
        : `Pitch the plan in one short sentence ("I have three ${duration}-minute slots that fit — Sunday morning, Tuesday evening and Thursday morning. Lock them in?"). On yes, call create_event per proposed slot with title "${title}", startsAt as given, and endsAt = startsAt + ${duration} minutes.`,
  });
}

/**
 * Group upcoming events by city or short-prefix location string, so the model
 * can offer to batch tasks on a day the user is already heading somewhere.
 */
export function answerClusterErrands(
  args: Record<string, unknown>,
  input: VoiceTurnInput,
): string {
  const lookAhead = Math.max(
    1,
    Math.min(
      14,
      typeof args.lookAheadDays === 'number' ? Math.round(args.lookAheadDays) : 7,
    ),
  );

  const zone = input.timezone;
  const nowMs = input.now.getTime();
  const horizonMs = nowMs + lookAhead * 24 * 60 * 60 * 1000;

  // "City" from a free-text location: take the first comma segment, lowercased
  // and trimmed. "Beer Sheva, Industrial Zone" and "Beer Sheva, HaRav Herzog"
  // both land in "beer sheva".
  const cityOf = (loc: string): string =>
    loc.split(',')[0]!.trim().toLowerCase().replace(/\s+/g, ' ');

  const relevant = input.snapshot.events
    .filter((e) => {
      if (!e.location || !e.location.trim()) return false;
      const t = new Date(e.startsAt).getTime();
      return Number.isFinite(t) && t >= nowMs && t <= horizonMs;
    })
    .map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      day: dayOf(e.startsAt, zone)!,
      location: e.location!.trim(),
      city: cityOf(e.location!),
    }));

  if (relevant.length < 2) {
    return JSON.stringify({
      ok: true,
      clusters: [],
      note:
        relevant.length === 0
          ? 'No upcoming events have a location set in the lookahead. Encourage the user to add locations to events so clustering can work.'
          : 'Only one upcoming event has a location — not enough to cluster. Say so plainly, do not invent a cluster.',
    });
  }

  // Group by city.
  const byCity = new Map<string, typeof relevant>();
  for (const e of relevant) {
    const bucket = byCity.get(e.city);
    if (bucket) bucket.push(e);
    else byCity.set(e.city, [e]);
  }

  // Only real clusters: two or more events in the same city, and preferably
  // on different days — a cluster on one day already is one trip; the leverage
  // is proposing to batch another errand onto that trip.
  const clusters: Array<{
    city: string;
    events: Array<{ id: string; title: string; day: string; startsAt: string; location: string }>;
    spansDays: boolean;
  }> = [];
  for (const [city, es] of byCity.entries()) {
    if (es.length < 2) continue;
    const days = new Set(es.map((e) => e.day));
    clusters.push({
      city,
      events: es
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .map((e) => ({
          id: e.id,
          title: e.title,
          day: e.day,
          startsAt: e.startsAt,
          location: e.location,
        })),
      spansDays: days.size > 1,
    });
  }

  clusters.sort((a, b) => b.events.length - a.events.length);

  return JSON.stringify({
    ok: true,
    lookAheadDays: lookAhead,
    clusters: clusters.slice(0, 3),
    instruction:
      clusters.length === 0
        ? 'No cities repeat in the lookahead. Say so briefly, nothing to batch.'
        : 'Name the biggest cluster plainly ("you have two things in Beer Sheva next week — Monday and Thursday"). If spansDays is true, offer to add any pending errand onto one of the days. Keep it to one sentence; use present_cards if details help.',
  });
}

/**
 * End-of-day close: what landed, what slipped, tomorrow's first thing.
 *
 * Zone-aware. Does not shame the user for unfinished tasks — the instruction
 * explicitly tells the model to lead with wins.
 */
export function answerEndOfDay(
  _args: Record<string, unknown>,
  input: VoiceTurnInput,
): string {
  const zone = input.timezone;
  const nowMs = input.now.getTime();
  const todayStr = today(zone, nowMs);
  const tomorrowStr = today(zone, nowMs + 24 * 60 * 60 * 1000);

  // Tasks whose dueAt is today.
  const todayTasks = input.snapshot.tasks.filter(
    (t) => t.dueAt && dayOf(t.dueAt, zone) === todayStr,
  );
  const done = todayTasks.filter((t) => t.isDone);
  const open = todayTasks.filter((t) => !t.isDone);

  // Events that happened today (started before now).
  const todayEvents = input.snapshot.events.filter(
    (e) => dayOf(e.startsAt, zone) === todayStr,
  );
  const eventsBehindNow = todayEvents.filter(
    (e) => new Date(e.startsAt).getTime() <= nowMs,
  );

  // Money that moved today.
  const todayMoney = input.snapshot.money.filter((m) => m.date === todayStr);
  const spent = todayMoney
    .filter((m) => m.kind === 'expense')
    .reduce((s, m) => s + m.amount, 0);
  const earned = todayMoney
    .filter((m) => m.kind === 'income')
    .reduce((s, m) => s + m.amount, 0);
  const cur = input.snapshot.currency ? ` ${input.snapshot.currency}` : '';
  const amt = (n: number) => `${Math.round(n * 100) / 100}${cur}`;

  // Tomorrow's first event, if any.
  const tomorrowEvents = input.snapshot.events
    .filter((e) => dayOf(e.startsAt, zone) === tomorrowStr)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const tomorrowFirst = tomorrowEvents[0]
    ? {
        title: tomorrowEvents[0].title,
        startsAt: tomorrowEvents[0].startsAt,
        location: tomorrowEvents[0].location ?? null,
      }
    : null;

  return JSON.stringify({
    ok: true,
    today: {
      tasksDone: done.length,
      tasksOpen: open.length,
      openTitles: open.slice(0, 3).map((t) => ({ id: t.id, title: t.title })),
      eventsHeld: eventsBehindNow.length,
      spent: amt(spent),
      earned: amt(earned),
    },
    tomorrow: {
      first: tomorrowFirst,
      eventCount: tomorrowEvents.length,
    },
    instruction:
      done.length === 0 && open.length === 0 && eventsBehindNow.length === 0
        ? 'The day was quiet — no scheduled items. Say that plainly, no shame.'
        : 'Lead with a win ("you shipped ' +
          String(done.length) +
          ' today"), note what slipped in one phrase (not a list), and name tomorrow\'s first thing with a time. If anything slipped, offer replan_remainder in the SAME reply ("want me to find a spot for them tomorrow?"). Use present_summary if the numbers help on screen; never read every slipped task aloud.',
  });
}

/**
 * Turns a create or move that cannot be kept into an offer of times that can.
 *
 * Returns null when there is nothing to say — a different tool, no time on it,
 * or a time that is perfectly fine — and the caller carries on unchanged.
 *
 * The model is told the tool did not do what it asked for, in the same shape
 * as any other refusal, so its closing sentence says the meeting was not made
 * and why. What it must not do is describe the alternatives: those are on
 * screen as something to tap, and reading four times aloud is worse than
 * saying there are four.
 */
async function reviewProposedTime(
  action: VoiceAction,
  snapshot: Snapshot,
  timeZone: string,
  now: number,
  profile?: Profile,
): Promise<{ action: VoiceAction; result: string } | null> {
  if (action.tool !== 'create_event' && action.tool !== 'update_event') return null;

  const args = action.arguments;
  const startsAt = typeof args.startsAt === 'string' ? args.startsAt : null;
  if (!startsAt) return null;

  const known: KnownEvent[] = snapshot.events.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt ?? null,
    location: e.location ?? null,
  }));

  const movingId = action.tool === 'update_event' && typeof args.id === 'string' ? args.id : undefined;
  const moving = movingId ? known.find((e) => e.id === movingId) : undefined;

  const proposed: ProposedEvent = {
    title:
      (typeof args.title === 'string' && args.title) ||
      moving?.title ||
      (typeof args.matchTitle === 'string' ? args.matchTitle : 'the meeting'),
    startsAt,
    endsAt: typeof args.endsAt === 'string' ? args.endsAt : null,
    location:
      (typeof args.location === 'string' && args.location) || moving?.location || null,
  };

  const verdict = await reviewSchedule(
    proposed,
    known,
    timeZone,
    movingId,
    now,
    profile
      ? {
          sleepStartHour: profile.sleepStartHour,
          sleepEndHour: profile.sleepEndHour,
          bufferMinutes: profile.bufferMinutes,
        }
      : undefined,
  );
  if (verdict.ok) return null;

  const offer: VoiceAction = {
    tool: 'offer_times',
    arguments: {
      reason: verdict.reason,
      title: proposed.title,
      requestedAt: startsAt,
      durationMinutes: verdict.durationMinutes,
      ...(proposed.location ? { location: proposed.location } : {}),
      ...(verdict.reason === 'clash'
        ? { clashWith: verdict.clashWith }
        : { travel: verdict.travel }),
      options: verdict.options,
    },
  };

  const because =
    verdict.reason === 'clash'
      ? `"${verdict.clashWith}" is already at that time.`
      : `They would be at "${verdict.travel.fromTitle}" in ${verdict.travel.fromPlace} and could not reach ${verdict.travel.toPlace} in ${verdict.travel.availableMinutes} minutes — it needs at least ${verdict.travel.neededMinutes}.`;

  return {
    action: offer,
    result: JSON.stringify({
      ok: false,
      error: `Not scheduled. ${because}`,
      offeredCount: verdict.options.length,
      instruction:
        verdict.options.length > 0
          ? 'Say briefly why it does not work and that other times are on screen to choose from. Do NOT read the times out.'
          : 'Say briefly why it does not work, and that nothing else is free — ask what they want to do.',
    }),
  };
}

/** Titles are compared as a person would hear them, not byte for byte. */
function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/**
 * Validates one tool call. Returns the action to send to the device, plus the
 * result string the model sees next round.
 *
 * Exported for tests: this is the gate every hallucinated id, bogus argument
 * and duplicate has to fail at, and it is worth checking without paying for a
 * round trip to the model to get here.
 */
export function collectAction(
  name: string,
  rawArguments: string,
  snapshot: Snapshot,
  timezone: string,
): { action: VoiceAction | null; result: string } {
  if (!isActionName(name)) {
    logger.warn({ name }, 'voice agent invoked an unknown tool');
    return { action: null, result: JSON.stringify({ ok: false, error: `Unknown tool ${name}` }) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || '{}');
  } catch {
    return { action: null, result: JSON.stringify({ ok: false, error: 'Arguments were not JSON' }) };
  }

  const validated = ARG_SCHEMAS[name].safeParse(parsed);
  if (!validated.success) {
    return {
      action: null,
      result: JSON.stringify({ ok: false, error: 'Invalid arguments', issues: validated.error.issues }),
    };
  }

  // An id the model made up matches nothing the device sent us. Refusing here
  // is what stops a hallucinated id from deleting a real row.
  const source = ID_SOURCE[name];
  if (source) {
    const { id, matchTitle } = validated.data as { id: string; matchTitle: string };
    const row = rowsOf(snapshot, source).find((r) => r.id === id);
    if (!row) {
      logger.warn({ name, id }, 'voice agent referenced an id outside the snapshot');
      return {
        action: null,
        result: JSON.stringify({
          ok: false,
          error: 'No entry with that id. Use an id from the agenda, or ask the user which one.',
        }),
      };
    }
    if (normalizeTitle(row.title) !== normalizeTitle(matchTitle)) {
      logger.warn({ name, id }, 'voice agent named an entry it did not identify');
      return {
        action: null,
        result: JSON.stringify({
          ok: false,
          error: `Entry ${id} is titled "${row.title}", not "${matchTitle}". If nothing in the agenda is what the user meant, tell them so instead of picking the closest one.`,
        }),
      };
    }
  }

  const args = validated.data as Record<string, unknown>;

  if (alreadyOnAgenda(name, args, snapshot, timezone)) {
    logger.warn(
      { name, title: args.title ?? args.name },
      'voice agent tried to re-add an existing entry',
    );
    return {
      action: null,
      result: JSON.stringify({
        ok: false,
        error:
          name === 'add_shopping_item'
            ? `"${args.name}" is already on the shopping list. Say so rather than adding it again.`
            : `"${args.title}" is already on the agenda for that day. Mention it rather than adding it again.`,
      }),
    };
  }

  return {
    action: { tool: name, arguments: args },
    result: JSON.stringify({ ok: true }),
  };
}
