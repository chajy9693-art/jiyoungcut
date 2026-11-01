import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const FONTS_DIR = process.env.FONTS_DIR || path.join(ROOT, 'fonts');
export const FONT_NAME = process.env.FONT_NAME || 'Pretendard';
export const PORT = Number(process.env.PORT || 3000);

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB || 4096) * 1024 * 1024;
export const MAX_DURATION_SEC = Number(process.env.MAX_DURATION_MIN || 180) * 60;

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'whisper-1';
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

// 키 없이 UI/렌더링 파이프라인만 확인하는 데모 모드
export const MOCK_AI = process.env.MOCK_AI === '1';

export const OUT_W = 1080;
export const OUT_H = 1920;
