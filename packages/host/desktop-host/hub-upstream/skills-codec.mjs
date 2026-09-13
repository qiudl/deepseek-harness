// Generated pure functions from pinned Hub skills.ts; see UPSTREAM.json and LICENSE.
import { parseDocument, stringify } from 'yaml';
import { basename, dirname } from 'node:path';
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** frontmatter 缺 name 时的回退名：bundle（SKILL.md）取目录名，扁平（<name>.md）取文件名 */
function fallbackSkillName(path) {
    const base = basename(path);
    if (base === 'SKILL.md')
        return dirname(path).split(/[\\/]/).pop() ?? '';
    if (base.endsWith('.md'))
        return base.slice(0, -3);
    return '';
}
/** 切换可见性并回写文件（model 可见 = 移除 disable-model-invocation）
 * 只修改 frontmatter 的目标字段（YAML AST 级），保留其余元数据与正文原样。 */
export function setInvocation(path, text, kind, value) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m)
        throw new Error('skill 文件缺少 frontmatter');
    const doc = parseDocument(m[1]);
    if (doc.errors.length > 0)
        throw new Error(`frontmatter 解析失败: ${doc.errors[0].message}`);
    const meta = (doc.toJS() ?? {});
    const name = typeof meta.name === 'string' && KEBAB.test(meta.name) ? meta.name : fallbackSkillName(path);
    if (!name)
        throw new Error('无法确定 skill 名称');
    if (typeof meta.name !== 'string')
        doc.setIn(['name'], name);
    const key = kind === 'model' ? 'disable-model-invocation' : 'user-invocable';
    if (value)
        doc.deleteIn([key]);
    // disable-model-invocation: true 与 user-invocable: false 都是「关闭」语义
    else
        doc.setIn([key], kind === 'model' ? true : false);
    const next = `---\n${doc.toString().trimEnd()}\n---\n${m[2]}`;
    return next;
}
/** 解析 SKILL.md / <name>.md：frontmatter + 正文 */
export function parseSkillFile(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m)
        return { meta: {}, body: text };
    const doc = parseDocument(m[1]);
    const meta = doc.errors.length > 0 ? {} : (doc.toJS() ?? {});
    return { meta, body: m[2].replace(/^\n/, '') };
}
/** 组装带 frontmatter 的 SKILL.md 文本 */
export function renderSkillFile(input) {
    const meta = { name: input.name, description: input.description };
    if (input.whenToUse)
        meta.whenToUse = input.whenToUse;
    if (!input.modelInvocable)
        meta['disable-model-invocation'] = true;
    if (!input.userInvocable)
        meta['user-invocable'] = false;
    const body = input.body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
    return `---\n${stringify(meta).trimEnd()}\n---\n${body}`;
}
/**
 * 校验并规整 zip 内相对路径。
 * 拒绝：`..` segment、绝对路径（`/` 或盘符 `C:`）、UNC、NUL 字节、空路径。
 * 返回以 `/` 分隔的相对 segments；非法返回 null（调用方整体拒绝该包）。
 */
function safeZipRelPath(entryName) {
    const norm = entryName.replace(/\\/g, '/');
    if (norm.includes('\0'))
        return null;
    if (norm.startsWith('/'))
        return null;
    if (/^[A-Za-z]:/.test(norm))
        return null;
    const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
    if (parts.some((p) => p === '..'))
        return null;
    if (parts.length === 0)
        return null;
    return parts.join('/');
}
/** 解析 GitHub skill 仓库链接（支持 /tree/<branch>/<path> 与根仓库） */
export function parseGitHubSkillUrl(url) {
    const m = url.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/|$)/);
    if (!m)
        throw new Error(`不是有效的 GitHub 链接: ${url}`);
    const rest = url.trim().slice(m[0].length);
    if (!rest)
        return { owner: m[1], repo: m[2], branch: 'main', subPath: '' };
    const tree = rest.match(/^tree\/([^/]+)(?:\/(.*))?$/);
    if (tree)
        return { owner: m[1], repo: m[2], branch: tree[1], subPath: tree[2] ?? '' };
    const blob = rest.match(/^blob\/([^/]+)\/(.+)\.md$/);
    if (blob)
        return { owner: m[1], repo: m[2], branch: blob[1], subPath: blob[2] };
    throw new Error(`暂不支持该 GitHub 路径（支持仓库根或 /tree/<branch>/<path>）: ${url}`);
}
export { safeZipRelPath };
