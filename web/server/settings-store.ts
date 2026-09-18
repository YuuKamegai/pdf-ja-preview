/**
 * `settings.json` の読み書き。
 *
 * 持つのは「登録済みの接続一覧」と「いま選んでいる接続」だけ。ポートや抽出器の
 * 設定は環境変数のまま置く。ここが「どの LLM へ送るか」の唯一の真実である。
 *
 * 鍵は暗号化済みの形でしか書かない。平文で置かれていたら読まずに未登録として扱う
 * （利用者が手で書いた場合に、気づかないまま平文が残り続けるのを避ける）。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  ConnectionError,
  normalizeName,
  validateConnection,
  viewOf,
  type Connection,
  type ConnectionInput,
  type ConnectionView,
} from './connection';
import { isProtected, protect, unprotect } from './secret';

export const SETTINGS_VERSION = 2;

export interface StoredSettings {
  version: number;
  selected: string;
  connections: Connection[];
}

/** より新しい版で作られた設定。上書きせず起動を止める。 */
export class SettingsVersionError extends Error {
  constructor(version: number) {
    super(
      `設定ファイルがより新しい版（version ${version}）で作られています。` +
        'この版では読めません。新しい版を使うか、設定ファイルを退避してください。',
    );
    this.name = 'SettingsVersionError';
  }
}

export type MigrationSeed = (legacyApiKeyProtected: string | undefined) => {
  connections: Connection[];
  selected: string;
};

/** 保存されている 1 件を、信用せずに読み直す。読めなければ undefined。 */
function parseStored(raw: unknown): Connection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  let base: Omit<Connection, 'apiKeyProtected'>;
  try {
    base = validateConnection(record as unknown as ConnectionInput);
  } catch {
    return undefined;
  }
  const stored = record.apiKeyProtected;
  return typeof stored === 'string' && stored !== '' ? { ...base, apiKeyProtected: stored } : base;
}

export class SettingsStore {
  readonly #path: string;
  #settings: StoredSettings | undefined;

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'settings.json');
  }

  get path(): string {
    return this.#path;
  }

  async #readRaw(): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      // 壊れた設定で起動を止めない。無いのと同じ扱いにする。
      return undefined;
    }
  }

  async #save(settings: StoredSettings): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    this.#settings = settings;
  }

  /**
   * 読み込む。v1 またはファイル無しなら、渡された種で一度だけ移行して書き出す。
   * より新しい version なら投げる（上書きしない）。
   */
  async loadOrMigrate(seed: MigrationSeed): Promise<StoredSettings> {
    if (this.#settings) return this.#settings;

    const raw = await this.#readRaw();
    const version = raw?.version;

    if (typeof version === 'number' && version > SETTINGS_VERSION) {
      throw new SettingsVersionError(version);
    }

    if (version === SETTINGS_VERSION) {
      const list = Array.isArray(raw?.connections) ? raw.connections : [];
      const connections = list
        .map((entry) => parseStored(entry))
        .filter((entry): entry is Connection => entry !== undefined);
      if (connections.length > 0) {
        const selected =
          typeof raw?.selected === 'string' &&
          connections.some((connection) => connection.name === raw.selected)
            ? raw.selected
            : connections[0].name;
        this.#settings = { version: SETTINGS_VERSION, selected, connections };
        return this.#settings;
      }
      // 中身が壊れている。種で立ち上げ直す。
    }

    const legacy = typeof raw?.apiKey === 'string' && raw.apiKey !== '' ? raw.apiKey : undefined;
    const built = seed(legacy);
    const settings: StoredSettings = {
      version: SETTINGS_VERSION,
      selected: built.selected,
      connections: built.connections,
    };
    await this.#save(settings);
    return settings;
  }

  #current(): StoredSettings {
    if (!this.#settings) throw new Error('loadOrMigrate() を先に呼んでください');
    return this.#settings;
  }

  #find(name: string): number {
    const wanted = name.toLowerCase();
    return this.#current().connections.findIndex(
      (connection) => connection.name.toLowerCase() === wanted,
    );
  }

  list(): Promise<{ selected: string; connections: ConnectionView[] }> {
    const settings = this.#current();
    return Promise.resolve({
      selected: settings.selected,
      connections: settings.connections.map((connection) => viewOf(connection)),
    });
  }

  /** 名前で 1 件引く。鍵の暗号文を含むので、そのまま外へ出さないこと。 */
  get(name: string): Connection | undefined {
    const index = this.#find(name);
    return index < 0 ? undefined : this.#current().connections[index];
  }

  async add(input: ConnectionInput, apiKey?: string | null): Promise<void> {
    const next = validateConnection(input);
    if (this.#find(next.name) >= 0) {
      throw new ConnectionError('duplicate-name', `その接続名は既にあります: ${next.name}`);
    }
    const connection: Connection = { ...next };
    if (typeof apiKey === 'string') connection.apiKeyProtected = await protect(apiKey);
    const settings = this.#current();
    await this.#save({ ...settings, connections: [...settings.connections, connection] });
  }

  async update(name: string, input: ConnectionInput, apiKey?: string | null): Promise<void> {
    const index = this.#find(normalizeName(name));
    if (index < 0) throw new ConnectionError('unknown-connection', 'その接続はありません');
    const settings = this.#current();
    const current = settings.connections[index];
    const next = validateConnection(input);

    const renamed = this.#find(next.name);
    if (renamed >= 0 && renamed !== index) {
      throw new ConnectionError('duplicate-name', `その接続名は既にあります: ${next.name}`);
    }

    const connection: Connection = { ...next };
    // 送信先が変わったら古い鍵を持ち越さない。
    if (
      current.provider === next.provider &&
      current.baseUrl === next.baseUrl &&
      apiKey === undefined &&
      current.apiKeyProtected !== undefined
    ) {
      connection.apiKeyProtected = current.apiKeyProtected;
    }
    if (typeof apiKey === 'string') connection.apiKeyProtected = await protect(apiKey);

    const connections = [...settings.connections];
    connections[index] = connection;
    const selected = settings.selected === current.name ? connection.name : settings.selected;
    await this.#save({ ...settings, selected, connections });
  }

  async remove(name: string): Promise<void> {
    const index = this.#find(normalizeName(name));
    if (index < 0) throw new ConnectionError('unknown-connection', 'その接続はありません');
    const settings = this.#current();
    if (settings.connections.length <= 1) {
      throw new ConnectionError('last-connection', '最後の 1 件は削除できません');
    }
    const connections = settings.connections.filter((_, at) => at !== index);
    const selected = connections.some((connection) => connection.name === settings.selected)
      ? settings.selected
      : connections[0].name;
    await this.#save({ ...settings, selected, connections });
  }

  async select(name: string): Promise<void> {
    const index = this.#find(normalizeName(name));
    if (index < 0) throw new ConnectionError('unknown-connection', 'その接続はありません');
    const settings = this.#current();
    await this.#save({ ...settings, selected: settings.connections[index].name });
  }

  /** 選択中の接続と、復号した鍵。読めない鍵は未登録として扱う。 */
  async resolveSelected(): Promise<{ connection: Connection; apiKey: string }> {
    const settings = this.#current();
    const connection =
      settings.connections.find((entry) => entry.name === settings.selected) ??
      settings.connections[0];
    return { connection, apiKey: await this.#decrypt(connection) };
  }

  async #decrypt(connection: Connection): Promise<string> {
    const stored = connection.apiKeyProtected;
    if (stored === undefined || stored === '' || !isProtected(stored)) return '';
    try {
      return await unprotect(stored);
    } catch {
      // 読めない鍵は未登録として扱う。内容は例外にもログにも出さない。
      return '';
    }
  }
}
