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
    '- Calling the tool is the only thing that changes anything. Saying "I am',
    '  deleting it" or "I will add that" without a tool call in the same reply',
    '  changes nothing and is a broken promise — so when the user asks for a',
    '  change, call the tool right now, in this reply.',
    '- A request can need several tools at once. Call all of them.',
    '- Touch only what was asked for. Never rewrite an entry the user did not',
    '  mention, and never "tidy up" times or titles on your own.',
    '- Answering a question about the schedule needs no tool: the agenda is',
    '  below. Everything on it already exists — reading an entry out loud is',
    '  never a reason to create it.',
    '- Ids come only from the agenda below. Never invent one.',
    '- Act on an entry only when its title is clearly the one the user named.',
    '  If nothing in the agenda matches, say so — never fall back to the closest',
    '  entry, and never delete something they did not ask about.',
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
    '  3. If their location is known and the shopping list has unbought items,',
    '     call find_nearby for supermarket or shopping and mention a nearby store.',
    '  4. Suggest one small actionable thing based on their schedule — e.g. "you',
    '     have a free hour before your 3pm, good time to knock out that errand".',
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
