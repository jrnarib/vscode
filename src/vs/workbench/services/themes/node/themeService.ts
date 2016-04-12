/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import {TPromise} from 'vs/base/common/winjs.base';
import nls = require('vs/nls');
import Paths = require('vs/base/common/paths');
import Json = require('vs/base/common/json');
import Themes = require('vs/platform/theme/common/themes');
import {IThemeExtensionPoint} from 'vs/platform/theme/common/themeExtensionPoint';
import {IExtensionService} from 'vs/platform/extensions/common/extensions';
import {ExtensionsRegistry, IExtensionMessageCollector} from 'vs/platform/extensions/common/extensionsRegistry';
import {IThemeService, IThemeData, DEFAULT_THEME_ID} from 'vs/workbench/services/themes/common/themeService';

import plist = require('vs/base/node/plist');
import pfs = require('vs/base/node/pfs');

// implementation

let defaultBaseTheme = Themes.getBaseThemeId(DEFAULT_THEME_ID);

const defaultThemeExtensionId = 'vscode-theme-defaults';
const oldDefaultThemeExtensionId = 'vscode-theme-colorful-defaults';

function validateThemeId(theme: string) : string {
	// migrations
	switch (theme) {
		case 'vs': return `vs ${defaultThemeExtensionId}-themes-light_vs-json`;
		case 'vs-dark': return `vs-dark ${defaultThemeExtensionId}-themes-dark_vs-json`;
		case 'hc-black': return `hc-black ${defaultThemeExtensionId}-themes-hc_black-json`;
		case `vs ${oldDefaultThemeExtensionId}-themes-light_plus-tmTheme`: return `vs ${defaultThemeExtensionId}-themes-light_plus-json`;
		case `vs-dark ${oldDefaultThemeExtensionId}-themes-dark_plus-tmTheme`: return `vs-dark ${defaultThemeExtensionId}-themes-dark_plus-json`;
	}
	return theme;
}

let themesExtPoint = ExtensionsRegistry.registerExtensionPoint<IThemeExtensionPoint[]>('themes', {
	description: nls.localize('vscode.extension.contributes.themes', 'Contributes textmate color themes.'),
	type: 'array',
	defaultSnippets: [{ body: [{ label: '{{label}}', uiTheme: 'vs-dark', path: './themes/{{id}}.tmTheme.' }] }],
	items: {
		type: 'object',
		defaultSnippets: [{ body: { label: '{{label}}', uiTheme: 'vs-dark', path: './themes/{{id}}.tmTheme.' } }],
		properties: {
			label: {
				description: nls.localize('vscode.extension.contributes.themes.label', 'Label of the color theme as shown in the UI.'),
				type: 'string'
			},
			uiTheme: {
				description: nls.localize('vscode.extension.contributes.themes.uiTheme', 'Base theme defining the colors around the editor: \'vs\' is the light color theme, \'vs-dark\' is the dark color theme.'),
				enum: ['vs', 'vs-dark', 'hc-black']
			},
			path: {
				description: nls.localize('vscode.extension.contributes.themes.path', 'Path of the tmTheme file. The path is relative to the extension folder and is typically \'./themes/themeFile.tmTheme\'.'),
				type: 'string'
			}
		}
	}
});

interface ThemeSettingStyle {
	background?: string;
	foreground?: string;
	fontStyle?: string;
	caret?: string;
	invisibles?: string;
	lineHighlight?: string;
	selection?: string;
}

interface ThemeSetting {
	name?: string;
	scope?: string | string[];
	settings: ThemeSettingStyle[];
}

interface ThemeDocument {
	name: string;
	include: string;
	settings: ThemeSetting[];
}

export class ThemeService implements IThemeService {
	serviceId = IThemeService;

	private knownThemes: IThemeData[];

	constructor(private extensionService: IExtensionService) {
		this.knownThemes = [];

		themesExtPoint.setHandler((extensions) => {
			for (let ext of extensions) {
				this.onThemes(ext.description.extensionFolderPath, ext.description.id, ext.value, ext.collector);
			}
		});
	}

	public loadTheme(themeId: string): TPromise<IThemeData> {
		themeId = validateThemeId(themeId);
		return this.getThemes().then(allThemes => {
			let themes = allThemes.filter(t => t.id === themeId);
			if (themes.length > 0) {
				return themes[0];
			}
			return null;
		});
	}

	public applyThemeCSS(themeId: string): TPromise<boolean> {
		return this.loadTheme(themeId).then(theme => {
			if (theme) {
				return applyTheme(theme);
			}
			return null;
		});
	}

	public getThemes(): TPromise<IThemeData[]> {
		return this.extensionService.onReady().then(isReady => {
			return this.knownThemes;
		});
	}

	private onThemes(extensionFolderPath: string, extensionId: string, themes: IThemeExtensionPoint[], collector: IExtensionMessageCollector): void {
		if (!Array.isArray(themes)) {
			collector.error(nls.localize(
				'reqarray',
				"Extension point `{0}` must be an array.",
				themesExtPoint.name
			));
			return;
		}
		themes.forEach(theme => {
			if (!theme.path || (typeof theme.path !== 'string')) {
				collector.error(nls.localize(
					'reqpath',
					"Expected string in `contributes.{0}.path`. Provided value: {1}",
					themesExtPoint.name,
					String(theme.path)
				));
				return;
			}
			let normalizedAbsolutePath = Paths.normalize(Paths.join(extensionFolderPath, theme.path));

			if (normalizedAbsolutePath.indexOf(extensionFolderPath) !== 0) {
				collector.warn(nls.localize('invalid.path.1', "Expected `contributes.{0}.path` ({1}) to be included inside extension's folder ({2}). This might make the extension non-portable.", themesExtPoint.name, normalizedAbsolutePath, extensionFolderPath));
			}

			let themeSelector = toCssSelector(extensionId + '-' + Paths.normalize(theme.path));
			this.knownThemes.push({
				id: `${theme.uiTheme || defaultBaseTheme} ${themeSelector}`,
				label: theme.label || Paths.basename(theme.path),
				description: theme.description,
				path: normalizedAbsolutePath
			});
		});
	}
}


function toCssSelector(str: string) {
	return str.replace(/[^_\-a-zA-Z0-9]/g, '-');
}

function applyTheme(theme: IThemeData): TPromise<boolean> {
	if (theme.styleSheetContent) {
		_applyRules(theme.styleSheetContent);
	}
	return _loadThemeDocument(theme.path).then(themeDocument => {
		let styleSheetContent = _processThemeObject(theme.id, themeDocument);
		theme.styleSheetContent = styleSheetContent;
		_applyRules(styleSheetContent);
		return true;
	}, error => {
		return TPromise.wrapError(nls.localize('error.cannotloadtheme', "Unable to load {0}", theme.path));
	});
}

function _loadThemeDocument(themePath: string) : TPromise<ThemeDocument> {
	return pfs.readFile(themePath).then(content => {
		if (Paths.extname(themePath) === '.json') {
			let errors: string[] = [];
			let contentValue = <ThemeDocument> Json.parse(content.toString(), errors);
			if (errors.length > 0) {
				return TPromise.wrapError(new Error(nls.localize('error.cannotparsejson', "Problems parsing JSON theme file: {0}", errors.join(', '))));
			}
			if (contentValue.include) {
				return _loadThemeDocument(Paths.join(Paths.dirname(themePath), contentValue.include)).then(includedValue => {
					contentValue.settings = includedValue.settings.concat(contentValue.settings);
					return TPromise.as(contentValue);
				});
			}
			return TPromise.as(contentValue);
		} else {
			let parseResult = plist.parse(content.toString());
			if (parseResult.errors && parseResult.errors.length) {
				return TPromise.wrapError(new Error(nls.localize('error.cannotparse', "Problems parsing plist file: {0}", parseResult.errors.join(', '))));
			}
			return TPromise.as(parseResult.value);
		}
	});
}

function _processThemeObject(themeId: string, themeDocument: ThemeDocument): string {
	let cssRules: string[] = [];

	let themeSettings : ThemeSetting[] = themeDocument.settings;
	let editorSettings : ThemeSettingStyle = {
		background: void 0,
		foreground: void 0,
		caret: void 0,
		invisibles: void 0,
		lineHighlight: void 0,
		selection: void 0
	};

	let themeSelector = `${Themes.getBaseThemeId(themeId)}.${Themes.getSyntaxThemeId(themeId)}`;

	if (Array.isArray(themeSettings)) {
		themeSettings.forEach((s : ThemeSetting, index, arr) => {
			if (index === 0 && !s.scope) {
				editorSettings = s.settings;
			} else {
				let scope: string | string[] = s.scope;
				let settings = s.settings;
				if (scope && settings) {
					let rules = Array.isArray(scope) ? <string[]> scope : scope.split(',');
					let statements = _settingsToStatements(settings);
					rules.forEach(rule => {
						rule = rule.trim().replace(/ /g, '.'); // until we have scope hierarchy in the editor dom: replace spaces with .

						cssRules.push(`.monaco-editor.${themeSelector} .token.${rule} { ${statements} }`);
					});
				}
			}
		});
	}

	if (editorSettings.background) {
		let background = new Color(editorSettings.background);
		//cssRules.push(`.monaco-editor.${themeSelector} { background-color: ${background}; }`);
		cssRules.push(`.monaco-editor.${themeSelector} .monaco-editor-background { background-color: ${background}; }`);
		cssRules.push(`.monaco-editor.${themeSelector} .glyph-margin { background-color: ${background}; }`);
		cssRules.push(`.monaco-workbench.${themeSelector} .monaco-editor-background { background-color: ${background}; }`);
	}
	if (editorSettings.foreground) {
		let foreground = new Color(editorSettings.foreground);
		cssRules.push(`.monaco-editor.${themeSelector} { color: ${foreground}; }`);
		cssRules.push(`.monaco-editor.${themeSelector} .token { color: ${foreground}; }`);
	}
	if (editorSettings.selection) {
		let selection = new Color(editorSettings.selection);
		cssRules.push(`.monaco-editor.${themeSelector} .focused .selected-text { background-color: ${selection}; }`);
		cssRules.push(`.monaco-editor.${themeSelector} .selected-text { background-color: ${selection.transparent(0.5)}; }`);
	}
	if (editorSettings.lineHighlight) {
		let lineHighlight = new Color(editorSettings.lineHighlight);
		cssRules.push(`.monaco-editor.${themeSelector} .current-line { background-color: ${lineHighlight}; border:0; }`);
	}
	if (editorSettings.caret) {
		let caret = new Color(editorSettings.caret);
		cssRules.push(`.monaco-editor.${themeSelector} .cursor { background-color: ${caret}; border-color: ${caret}; }`);
	}
	if (editorSettings.invisibles) {
		let invisibles = new Color(editorSettings.invisibles);
		cssRules.push(`.monaco-editor.${themeSelector} .token.whitespace { color: ${invisibles} !important; }`);
	}

	return cssRules.join('\n');
}

function _settingsToStatements(settings: ThemeSettingStyle): string {
	let statements: string[] = [];

	for (let settingName in settings) {
		var value = settings[settingName];
		switch (settingName) {
			case 'foreground':
				let foreground = new Color(value);
				statements.push(`color: ${foreground};`);
				break;
			case 'background':
				// do not support background color for now, see bug 18924
				//let background = new Color(value);
				//statements.push(`background-color: ${background};`);
				break;
			case 'fontStyle':
				let segments = value.split(' ');
				segments.forEach(s => {
					switch (value) {
						case 'italic':
							statements.push(`font-style: italic;`);
							break;
						case 'bold':
							statements.push(`font-weight: bold;`);
							break;
						case 'underline':
							statements.push(`text-decoration: underline;`);
							break;
					}
				});
		}
	}
	return statements.join(' ');
}

let className = 'contributedColorTheme';

function _applyRules(styleSheetContent: string) {
	let themeStyles = document.head.getElementsByClassName(className);
	if (themeStyles.length === 0) {
		let elStyle = document.createElement('style');
		elStyle.type = 'text/css';
		elStyle.className = className;
		elStyle.innerHTML = styleSheetContent;
		document.head.appendChild(elStyle);
	} else {
		(<HTMLStyleElement>themeStyles[0]).innerHTML = styleSheetContent;
	}
}

interface RGBA { r: number; g: number; b: number; a: number; }

class Color {

	private parsed: RGBA;
	private str: string;

	constructor(arg: string | RGBA) {
		if (typeof arg === 'string') {
			this.parsed = Color.parse(<string>arg);
		} else {
			this.parsed = <RGBA>arg;
		}
		this.str = null;
	}

	private static parse(color: string): RGBA {
		function parseHex(str: string) {
			return parseInt('0x' + str);
		}

		if (color.charAt(0) === '#' && color.length >= 7) {
			let r = parseHex(color.substr(1, 2));
			let g = parseHex(color.substr(3, 2));
			let b = parseHex(color.substr(5, 2));
			let a = color.length === 9 ? parseHex(color.substr(7, 2)) / 0xff : 1;
			return { r, g, b, a };
		}
		return { r: 255, g: 0, b: 0, a: 1 };
	}

	public toString(): string {
		if (!this.str) {
			let p = this.parsed;
			this.str = `rgba(${p.r}, ${p.g}, ${p.b}, ${+p.a.toFixed(2)})`;
		}
		return this.str;
	}

	public transparent(factor: number): Color {
		let p = this.parsed;
		return new Color({ r: p.r, g: p.g, b: p.b, a: p.a * factor });
	}
}