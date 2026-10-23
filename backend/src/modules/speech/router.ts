import { Router } from 'express';
import multer from 'multer';
import { transcribeAudio } from './transcribe.js';
import { authMiddleware } from '../../middleware/auth.js';
import { speechLimiter } from '../../middleware/rateLimit.js';
import { asyncHandler } from '../../lib/http.js';
import { config } from '../../config.js';
import {
  PayloadTooLarge,
  UnsupportedMedia,
  ValidationError,
} from '../../lib/errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

const ALLOWED_MIME_TYPES = new Set([
  'audio/m4a',
  'audio/x-m4a',
  'audio/mp4',
  'audio/webm',
  'video/webm', // some browsers send webm audio with video/webm
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
]);

const ALLOWED_EXTENSIONS = new Set(['m4a', 'webm', 'mp3', 'wav']);

const ALLOWED_LANGUAGES = new Set([
  'he', 'en', 'ar', 'es', 'fr', 'it', 'ru', 'de', 'pt', 'hi',
  'zh', 'ja', 'ko', 'tr', 'nl', 'pl', 'uk', 'ro', 'el', 'sv',
  'fa', 'id', 'vi', 'th', 'bn',
]);

// ─── Multer setup — memory storage, no disk writes ────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (ALLOWED_MIME_TYPES.has(file.mimetype) || ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      // Pass an error — multer will call next(err) for us
      cb(new UnsupportedMedia(`Unsupported audio format. Accepted: m4a, webm, mp3, wav.`));
    }
  },
});

// ─── Router ──────────────────────────────────────────────────────────────────

export const speechRouter = Router();

// POST /speech/transcribe
speechRouter.post(
  '/speech/transcribe',
  authMiddleware,
  speechLimiter,
  // Multer middleware for single 'audio' field
  (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
      if (!err) return next();

      // multer emits LIMIT_FILE_SIZE when the file exceeds limits.fileSize
      if (
        err instanceof multer.MulterError &&
        err.code === 'LIMIT_FILE_SIZE'
      ) {
        return next(new PayloadTooLarge('Audio file exceeds the 25 MB limit.'));
      }
      // Our own UnsupportedMedia thrown from fileFilter reaches here
      return next(err);
    });
  },
  asyncHandler(async (req, res) => {
    // Guard: require audio file
    if (!req.file) {
      throw new ValidationError('Missing required field: audio');
    }

    // Post-upload MIME / extension check (belt-and-braces: fileFilter already
    // rejects invalid types, but not all multer configurations guarantee it runs
    // before the file is buffered).
    const ext = req.file.originalname.split('.').pop()?.toLowerCase() ?? '';
    if (
      !ALLOWED_MIME_TYPES.has(req.file.mimetype) &&
      !ALLOWED_EXTENSIONS.has(ext)
    ) {
      throw new UnsupportedMedia(
        'Unsupported audio format. Accepted: m4a, webm, mp3, wav.',
      );
    }

    // Validate language field if present
    const rawLanguage =
      typeof req.body?.language === 'string' ? req.body.language : undefined;
    if (rawLanguage !== undefined && !ALLOWED_LANGUAGES.has(rawLanguage)) {
      throw new ValidationError(
        `Invalid language. Accepted values: he, en.`,
      );
    }
    const language = rawLanguage as 'he' | 'en' | undefined;

    // Require API key to be configured
    if (!config.OPENAI_API_KEY) {
      throw new ValidationError(
        'Speech transcription is not configured on this server',
      );
    }

    return res.status(200).json({ text: await transcribeAudio(req.file, language) });
  }),
);
