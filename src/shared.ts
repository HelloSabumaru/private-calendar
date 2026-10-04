import { z } from 'zod';

export const loginSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('basic'), username: z.string().min(1).max(256), password: z.string().min(1).max(4096) }),
  z.object({ method: z.literal('bearer'), token: z.string().min(1).max(4096) }),
]);
export type Login = z.infer<typeof loginSchema>;
export const recurrenceSchema = z.object({
  frequency: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  interval: z.number().int().min(1).max(999),
  weekdays: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).max(7).default([]),
  end: z.enum(['never', 'until', 'count']),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  count: z.number().int().min(1).max(100000).optional(),
}).superRefine((value, ctx) => {
  if (value.frequency !== 'NONE' && value.end === 'until' && !value.until) ctx.addIssue({ code: 'custom', message: 'Choose a recurrence end date.' });
  if (value.frequency !== 'NONE' && value.end === 'count' && !value.count) ctx.addIssue({ code: 'custom', message: 'Choose an occurrence count.' });
});
export type Recurrence = z.infer<typeof recurrenceSchema>;
export const draftSchema = z.object({
  calendarId: z.string().min(1).max(128),
  title: z.string().trim().min(1).max(1000), description: z.string().max(100000), location: z.string().max(2000),
  start: z.string().max(32), end: z.string().max(32), allDay: z.boolean(), timezone: z.string().min(1).max(256),
  startOffset: z.enum(['earlier', 'later']).optional(), endOffset: z.enum(['earlier', 'later']).optional(),
  recurrence: recurrenceSchema,
  reminder: z.union([z.literal('preserve'), z.literal('none'), z.number().int().min(0).max(525600)]),
});
export type EventDraft = z.infer<typeof draftSchema>;
export type Calendar = {
  id: string; name: string; color: string; canCreate: boolean; canUpdate: boolean; canDelete: boolean;
};
export type Occurrence = {
  id: string; resourceId: string; calendarId: string; title: string; description: string; location: string;
  start: string; end: string; allDay: boolean; recurring: boolean; recurrenceId?: string;
};
export type EventDetail = {
  id: string; etag: string; draft: EventDraft; recurring: boolean; scheduleEditable: boolean; recurrenceId?: string;
  editReason?: string; alarmCount: number; unsupportedAlarms: number; recurrenceText?: string;
  canUpdate: boolean; canDelete: boolean;
  deleteReason?: string;
};
export type Operation = { id: string; state: 'pending' | 'success' | 'failed' | 'uncertain'; resourceId?: string; error?: string; skipped?: boolean };
export type ApiErrorData = { code: string; message: string; retryable?: boolean; latest?: EventDetail; operationId?: string };
export type Preferences = {
  theme: 'system' | 'light' | 'dark'; firstWeekday: 0 | 1; hour12: boolean; timezone: string;
  defaultCalendar: string; reminder: number | 'none'; hiddenCalendars: string[];
};
export const defaultRecurrence: Recurrence = { frequency: 'NONE', interval: 1, weekdays: [], end: 'never' };

export type ImportEvent = { uid: string; title: string; ics: string };
