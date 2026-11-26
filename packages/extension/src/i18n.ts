/**
 * Translated text. EasyEDA returns a key it has no entry for unchanged, with its `${n}` placeholders
 * left in, so they are filled here as well.
 */
export function t(key: string, ...args: string[]): string {
	const text = eda.sys_I18n.text(key, undefined, undefined, ...args) ?? key;
	return args.length ? text.replace(/\$\{(\d+)\}/g, (m, n: string) => args[Number(n) - 1] ?? m) : text;
}
