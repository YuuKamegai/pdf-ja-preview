/**
 * `settings.json` の読み書き。
 *
 * ここに入るのは API キーだけ。他の設定は環境変数で渡す。設定の保存先を増やさず、
 * 「鍵はここ、それ以外は環境変数」という一行の規則で済ませるため。
 *
 * 鍵は暗号化済みの形でしか書かない。平文で置かれていたら読まずに拒否する
 * （利用者が手で書いた場合に、気づかないまま平文が残り続けるのを避ける）。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { isProtected, protect, unprotect } from './secret';

export interface StoredSettings {
  apiKey?: string;
}

export class SettingsStore {
  readonly #path: string;

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'settings.json');
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<StoredSettings> {
    let raw: string;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as StoredSettings;
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      // 壊れた設定で起動を止めない。鍵が無いのと同じ扱いにする。
      return {};
    }
  }

  async #save(settings: StoredSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  }

  async setApiKey(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === '') throw new Error('空の API キーは保存できません。');
    const settings = await this.load();
    settings.apiKey = await protect(trimmed);
    await this.#save(settings);
  }

  async clearApiKey(): Promise<void> {
    const settings = await this.load();
    if (settings.apiKey === undefined) return;
    delete settings.apiKey;
    if (Object.keys(settings).length === 0) {
      await rm(this.#path, { force: true });
      return;
    }
    await this.#save(settings);
  }

  async readApiKey(): Promise<string> {
    const settings = await this.load();
    const stored = settings.apiKey;
    if (stored === undefined || stored === '') return '';
    if (!isProtected(stored)) {
      throw new Error(
        '保存された API キーの形式が不明です。--set-key で登録し直してください。',
      );
    }
    return unprotect(stored);
  }
}
