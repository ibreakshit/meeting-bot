import type { BotSettings, SchedulerState } from './types';

export function isValidBotName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function isValidThumbnailId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function getBotSettings(state: SchedulerState, defaultName: string): BotSettings {
  return state.botSettings ? { ...state.botSettings } : { name: defaultName };
}
