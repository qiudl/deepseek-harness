/** Pure codecs reproduced from the pinned Hub source. */
export function parseSkillFile(text: string): { meta: Record<string, unknown>; body: string };
export function renderSkillFile(input: { name: string; description: string; whenToUse?: string; modelInvocable: boolean; userInvocable: boolean; body: string }): string;
export function safeZipRelPath(path: string): string | null;
export function parseGitHubSkillUrl(url: string): { owner: string; repo: string; branch: string; subPath: string };
export function setInvocation(path: string, text: string, kind: 'model' | 'user', value: boolean): string;
