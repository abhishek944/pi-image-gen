import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { join, resolve } from 'node:path';
import type { ImageGenSettings } from './types.js';

const SETTINGS_KEY = 'pi-image-gen';

export class SettingsWriteError extends Error {}

/**
 * Merge image-generation defaults into trusted project settings without
 * replacing unrelated top-level or extension-owned keys. The final rename is
 * atomic on the project filesystem. Calls in this extension process are
 * serialized by settings path so simultaneous commands cannot lose updates.
 */
export function updateProjectImageGenSettings(
  cwd: string,
  projectTrusted: boolean,
  update: Pick<ImageGenSettings, 'defaultProvider' | 'defaultModel'>,
): Promise<void> {
  const settingsPath = resolve(cwd, '.pi', 'settings.json');
  return withFileMutationQueue(settingsPath, () =>
    updateProjectImageGenSettingsNow(cwd, projectTrusted, update),
  );
}

async function updateProjectImageGenSettingsNow(
  cwd: string,
  projectTrusted: boolean,
  update: Pick<ImageGenSettings, 'defaultProvider' | 'defaultModel'>,
): Promise<void> {
  if (!projectTrusted) {
    throw new SettingsWriteError(
      'Project settings are not trusted. Trust this project before changing .pi/settings.json.',
    );
  }

  const settingsDir = join(cwd, '.pi');
  const settingsPath = join(settingsDir, 'settings.json');
  await rejectSymlink(settingsDir, 'The project .pi directory must not be a symbolic link.');
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  await rejectSymlink(settingsPath, 'The project settings file must not be a symbolic link.');

  let root: Record<string, unknown> = {};
  let mode = 0o600;
  try {
    const [text, stat] = await Promise.all([readFile(settingsPath, 'utf8'), lstat(settingsPath)]);
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new SettingsWriteError('Project settings must contain a JSON object.');
    root = parsed;
    mode = stat.mode & 0o777;
  } catch (error) {
    if (error instanceof SettingsWriteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new SettingsWriteError(
          'Project settings contain invalid JSON. Fix .pi/settings.json before changing image settings.',
        );
      }
      throw new SettingsWriteError('Could not read project settings.');
    }
  }

  const current = root[SETTINGS_KEY];
  if (current !== undefined && !isRecord(current)) {
    throw new SettingsWriteError('pi-image-gen settings must contain a JSON object.');
  }
  root[SETTINGS_KEY] = { ...(current ?? {}), ...withoutUndefined(update) };

  const tempPath = join(settingsDir, `.settings.json.pi-image-gen-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(tempPath, 'wx', mode);
    created = true;
    await handle.writeFile(`${JSON.stringify(root, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    await rename(tempPath, settingsPath);
  } catch {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best effort before unlinking the private temporary file.
      }
    }
    if (created) {
      try {
        await unlink(tempPath);
      } catch {
        // Best-effort cleanup only; preserve the fixed, path-free error below.
      }
    }
    throw new SettingsWriteError('Could not update project settings.');
  }
}

async function rejectSymlink(path: string, message: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new SettingsWriteError(message);
  } catch (error) {
    if (error instanceof SettingsWriteError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new SettingsWriteError('Could not inspect project settings.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
