/**
 * API キーの保存用の暗号化。
 *
 * Windows の DPAPI（CurrentUser スコープ）を使う。同じ Windows ユーザー・同じ PC
 * でだけ復号できる。
 *
 * Node に DPAPI は無い。ネイティブモジュールはこの machine の Smart App Control が
 * 弾くため使えない。署名済みの powershell.exe を経由して呼ぶ。
 *
 * Windows 以外では明示的に失敗させる。黙って平文で保存しない。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROTECTED_PREFIX = 'dpapi-current-user-v1:';

export function isProtected(value: string): boolean {
  return value.startsWith(PROTECTED_PREFIX);
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('API キーの保存には Windows の DPAPI が必要です。');
  }
}

/**
 * PowerShell を走らせる。値は標準入力で渡す。
 * コマンドライン引数に載せると、他のプロセスから見える（Win32_Process の CommandLine）。
 *
 * `protect` の戻り値（base64）は末尾に改行が付くため trim する。
 * `unprotect` の戻り値（鍵そのもの）は trim しない。鍵の末尾に空白が含まれる場合に
 * それを落としてしまうと、暗号化して復号すると元へ戻るという保証が崩れるため。
 * `unprotect` 側の PowerShell は `[Console]::Out.Write` を使い改行を付けずに書く。
 */
async function runPowerShell(
  script: string,
  input: string,
  options?: { trim?: boolean },
): Promise<string> {
  const child = execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  child.child.stdin?.end(input, 'utf8');
  const { stdout } = await child;
  return options?.trim === false ? stdout : stdout.trim();
}

const PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '[Console]::InputEncoding = [Text.Encoding]::UTF8;',
  '$plain = [Console]::In.ReadToEnd();',
  '$bytes = [Text.Encoding]::UTF8.GetBytes($plain);',
  '$out = [Security.Cryptography.ProtectedData]::Protect(',
  '  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Convert]::ToBase64String($out)',
].join(' ');

const UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security;',
  '[Console]::InputEncoding = [Text.Encoding]::UTF8;',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
  '$b64 = [Console]::In.ReadToEnd().Trim();',
  '$bytes = [Convert]::FromBase64String($b64);',
  '$out = [Security.Cryptography.ProtectedData]::Unprotect(',
  '  $bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))',
].join(' ');

export async function protect(value: string): Promise<string> {
  if (value === '') throw new Error('空の値は暗号化できません。');
  assertWindows();
  let encoded: string;
  try {
    encoded = await runPowerShell(PROTECT_SCRIPT, value, { trim: true });
  } catch (cause) {
    throw new Error('API キーの暗号化に失敗しました。', { cause });
  }
  if (encoded === '') throw new Error('API キーの暗号化に失敗しました。');
  return PROTECTED_PREFIX + encoded;
}

export async function unprotect(value: string): Promise<string> {
  if (!isProtected(value)) {
    throw new Error('保存された API キーの形式が不明です。登録し直してください。');
  }
  assertWindows();
  const encoded = value.slice(PROTECTED_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) {
    throw new Error('保存された API キーの暗号データが不正です。');
  }
  try {
    return await runPowerShell(UNPROTECT_SCRIPT, encoded, { trim: false });
  } catch (cause) {
    throw new Error('API キーを復号できません。登録し直してください。', { cause });
  }
}
