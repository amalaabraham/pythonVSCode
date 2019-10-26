// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../common/extensions';

import * as fs from 'fs-extra';
import { Server } from 'http';
import { Context } from 'koa';
import { AddressInfo } from 'net';
import * as path from 'path';
import { Uri, ViewColumn, Webview, WebviewPanel, window } from 'vscode';
import * as localize from '../../common/utils/localize';
import { Identifiers } from '../../datascience/constants';
import { ICodeCssGenerator } from '../../datascience/types';
import { IServiceContainer } from '../../ioc/types';
import { IDisposableRegistry } from '../types';
import { noop } from '../utils/misc';
import { IWebPanel, IWebPanelMessageListener, WebPanelMessage } from './types';

export class WebPanel implements IWebPanel {

    private listener: IWebPanelMessageListener;
    private panel: WebviewPanel | undefined;
    private loadPromise: Promise<void>;
    private disposableRegistry: IDisposableRegistry;
    private rootPath: string;
    private server?: Server;
    constructor(
        viewColumn: ViewColumn,
        serviceContainer: IServiceContainer,
        listener: IWebPanelMessageListener,
        title: string,
        mainScriptPath: string,
        embeddedCss?: string,
        // tslint:disable-next-line:no-any
        settings?: any,
        private readonly cssGenerator: ICodeCssGenerator) {
        this.disposableRegistry = serviceContainer.get<IDisposableRegistry>(IDisposableRegistry);
        this.listener = listener;
        this.rootPath = path.dirname(mainScriptPath);
        this.panel = window.createWebviewPanel(
            title.toLowerCase().replace(' ', ''),
            title,
            { viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [Uri.file(this.rootPath)]
            });
        this.loadPromise = this.load(mainScriptPath, embeddedCss, settings);
    }

    public async show(preserveFocus: boolean) {
        await this.loadPromise;
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn, preserveFocus);
        }
    }

    public close() {
        if (this.panel) {
            this.panel.dispose();
        }
        if (this.server){
            this.server.close();
            this.server = undefined;
        }
    }

    public isVisible(): boolean {
        return this.panel ? this.panel.visible : false;
    }

    public isActive(): boolean {
        return this.panel ? this.panel.active : false;
    }

    public postMessage(message: WebPanelMessage) {
        // if (this.panel && this.panel.webview) {
        //     this.panel.webview.postMessage(message);
        // }
        this.wsPostMessage(message);
    }
    public wsPostMessage = (message: WebPanelMessage) => {
        noop();
    };
    public get title(): string {
        return this.panel ? this.panel.title : '';
    }

    public set title(newTitle: string) {
        if (this.panel) {
            this.panel.title = newTitle;
        }
    }

    private async startWebServer(cwd: string, indexHtml: string): Promise<void> {
        type KoaType = typeof import('koa');
        // tslint:disable-next-line: no-require-imports
        const Koa: KoaType = require('koa') as KoaType;
        // tslint:disable-next-line: no-require-imports
        const koaStatic = require('koa-static') as typeof import('koa-static');
        // tslint:disable-next-line: no-require-imports
        const compose = require('koa-compose') as typeof import('koa-compose');
        // tslint:disable-next-line: no-require-imports
        const websockify = require('koa-websocket') as typeof import('koa-websocket');
        const app = websockify(new Koa());

        async function index(ctx: Context, next: Function) {
            if ('/index' === ctx.path) {
              ctx.body = indexHtml;
            } else {
              await next();
            }
        }

        // Regular middleware
        // Note it's app.ws.use and not app.use
        app.ws.use((ctx, next) => {
            // `ctx` is the regular koa context created from the `ws` onConnection `socket.upgradeReq` object.
            // the websocket is added to the context on `ctx.websocket`.
            // ctx.websocket.send({type:'Hello World', payload: {}});
            ctx.websocket.on('message', (message) => {
                // do something with the message from client
                // tslint:disable-next-line: no-console
                console.log(message);
                // tslint:disable-next-line: no-any
                const msg = JSON.parse(message) as any;
                this.listener.onMessage(msg.type, msg.payload);
            });
            this.wsPostMessage = data => {
                ctx.websocket.send(JSON.stringify(data));
            };
            ctx.websocket.on('error', (ex)=>{
                console.error(ex);
            });
            ctx.websocket.on('close', (code, reason)=>{
                console.error(code);
                console.error(reason);
            });
            // return `next` to pass the context (ctx) on to the next ws middleware
            return (next as Function)(ctx);
        });

        const middlewares  = compose([koaStatic(cwd), index]);

        app.use(middlewares);
        await new Promise((resolve, _reject) => {
            this.server = app.listen(undefined, undefined, undefined, resolve);
        });
    }
    // tslint:disable-next-line:no-any
    private async load(mainScriptPath: string, embeddedCss?: string, settings?: any) {
        if (this.panel) {
            if (await fs.pathExists(mainScriptPath)) {

                // Call our special function that sticks this script inside of an html page
                // and translates all of the paths to vscode-resource URIs
                const css = await this.cssGenerator.generateThemeCss(true, 'vscode-dark');
                const html = this.generateReactHtml(mainScriptPath, this.panel.webview, css, settings);
                await this.startWebServer(path.dirname(mainScriptPath), html);
                const port = (this.server!.address() as AddressInfo).port;
                console.error(port);
                console.error(port);
                console.error(port);
                console.error(port);
                // this.panel.webview.html = this.generateIFrameContainerHtml(port);
                this.panel.webview.html = '';
                const ChromeLauncher = require('chrome-launcher');
                ChromeLauncher.launch({
                    startingUrl: `http://localhost:${port}/index`
                });

                // Reset when the current panel is closed
                this.disposableRegistry.push(this.panel.onDidDispose(() => {
                    this.panel = undefined;
                    this.listener.dispose().ignoreErrors();
                }));

                this.disposableRegistry.push(this.panel.webview.onDidReceiveMessage(message => {
                    // Pass the message onto our listener
                    this.listener.onMessage(message.type, message.payload);
                }));

                this.disposableRegistry.push(this.panel.onDidChangeViewState((_e) => {
                    // Pass the state change onto our listener
                    this.listener.onChangeViewState(this);
                }));

                // Set initial state
                this.listener.onChangeViewState(this);
            } else {
                // Indicate that we can't load the file path
                const badPanelString = localize.DataScience.badWebPanelFormatString();
                this.panel.webview.html = badPanelString.format(mainScriptPath);
            }
        }
    }

    // tslint:disable-next-line:no-any
    private generateIFrameContainerHtml(port: number) {
        return `<!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
                <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https: http: blob:; default-src 'unsafe-inline' 'unsafe-eval' vscode-resource: data: https: http: ws:;">
                <meta name="theme-color" content="#000000">
                <meta name="theme" content="${Identifiers.GeneratedThemeName}"/>
                <title>React App</title>
            </head>
            <body>
            <iframe id="reactIFrame" frameborder="0" sandbox="allow-scripts allow-forms allow-same-origin" style="display: block; margin: 0px; overflow: hidden; position: absolute; width: 100%; height: 100%; visibility: visible;" src="http://localhost:${port}/index"></iframe>
            </body>
        </html>`;
    }

    // tslint:disable-next-line:no-any
    private generateReactHtml(mainScriptPath: string, webView: Webview, embeddedCss?: string, settings?: any) {
        // const uriBase = webView.asWebviewUri(Uri.file(`${path.dirname(mainScriptPath)}/`));
        const uri = webView.asWebviewUri(Uri.file(mainScriptPath));
        const locDatabase = localize.getCollectionJSON();
        const style = embeddedCss ? embeddedCss : '';
        const settingsString = settings ? JSON.stringify(settings) : '{}';

        return `<!doctype html>
        <html lang="en"><head><style id="_defaultStyles">
--vscode-activityBar-activeBorder:#ffffff; --vscode-activityBar-background:#333333; --vscode-activityBar-dropBackground:rgba(255, 255, 255, 0.12); --vscode-activityBar-foreground:#ffffff; --vscode-activityBar-inactiveForeground:rgba(255, 255, 255, 0.4); --vscode-activityBarBadge-background:#007acc; --vscode-activityBarBadge-foreground:#ffffff; --vscode-badge-background:#4d4d4d; --vscode-badge-foreground:#ffffff; --vscode-breadcrumb-activeSelectionForeground:#e0e0e0; --vscode-breadcrumb-background:#1e1e1e; --vscode-breadcrumb-focusForeground:#e0e0e0; --vscode-breadcrumb-foreground:rgba(204, 204, 204, 0.8); --vscode-breadcrumbPicker-background:#252526; --vscode-button-background:#0e639c; --vscode-button-foreground:#ffffff; --vscode-button-hoverBackground:#1177bb; --vscode-checkbox-background:#3c3c3c; --vscode-checkbox-border:#3c3c3c; --vscode-checkbox-foreground:#f0f0f0; --vscode-debugExceptionWidget-background:#420b0d; --vscode-debugExceptionWidget-border:#a31515; --vscode-debugToolBar-background:#333333; --vscode-descriptionForeground:rgba(204, 204, 204, 0.7); --vscode-diffEditor-insertedTextBackground:rgba(155, 185, 85, 0.2); --vscode-diffEditor-removedTextBackground:rgba(255, 0, 0, 0.2); --vscode-dropdown-background:#3c3c3c; --vscode-dropdown-border:#3c3c3c; --vscode-dropdown-foreground:#f0f0f0; --vscode-editor-background:#1e1e1e; --vscode-editor-findMatchBackground:#515c6a; --vscode-editor-findMatchHighlightBackground:rgba(234, 92, 0, 0.33); --vscode-editor-findRangeHighlightBackground:rgba(58, 61, 65, 0.4); --vscode-editor-focusedStackFrameHighlightBackground:rgba(122, 189, 122, 0.3); --vscode-editor-font-family:Menlo, Monaco, &quot;Courier New&quot;, monospace; --vscode-editor-font-size:12; --vscode-editor-font-weight:normal; --vscode-editor-foreground:#d4d4d4; --vscode-editor-hoverHighlightBackground:rgba(38, 79, 120, 0.25); --vscode-editor-inactiveSelectionBackground:#3a3d41; --vscode-editor-lineHighlightBorder:#282828; --vscode-editor-rangeHighlightBackground:rgba(255, 255, 255, 0.04); --vscode-editor-selectionBackground:#264f78; --vscode-editor-selectionHighlightBackground:rgba(173, 214, 255, 0.15); --vscode-editor-snippetFinalTabstopHighlightBorder:#525252; --vscode-editor-snippetTabstopHighlightBackground:rgba(124, 124, 124, 0.3); --vscode-editor-stackFrameHighlightBackground:rgba(255, 255, 0, 0.2); --vscode-editor-wordHighlightBackground:rgba(87, 87, 87, 0.72); --vscode-editor-wordHighlightStrongBackground:rgba(0, 73, 114, 0.72); --vscode-editorActiveLineNumber-foreground:#c6c6c6; --vscode-editorBracketMatch-background:rgba(0, 100, 0, 0.1); --vscode-editorBracketMatch-border:#888888; --vscode-editorCodeLens-foreground:#999999; --vscode-editorCursor-foreground:#aeafad; --vscode-editorError-foreground:#f48771; --vscode-editorGroup-border:#444444; --vscode-editorGroup-dropBackground:rgba(83, 89, 93, 0.5); --vscode-editorGroupHeader-noTabsBackground:#1e1e1e; --vscode-editorGroupHeader-tabsBackground:#252526; --vscode-editorGutter-addedBackground:#587c0c; --vscode-editorGutter-background:#1e1e1e; --vscode-editorGutter-commentRangeForeground:#c5c5c5; --vscode-editorGutter-deletedBackground:#94151b; --vscode-editorGutter-modifiedBackground:#0c7d9d; --vscode-editorHint-foreground:rgba(238, 238, 238, 0.7); --vscode-editorHoverWidget-background:#252526; --vscode-editorHoverWidget-border:#454545; --vscode-editorHoverWidget-statusBarBackground:#2c2c2d; --vscode-editorIndentGuide-activeBackground:#707070; --vscode-editorIndentGuide-background:#404040; --vscode-editorInfo-foreground:#75beff; --vscode-editorLightBulb-foreground:#ffcc00; --vscode-editorLightBulbAutoFix-foreground:#75beff; --vscode-editorLineNumber-activeForeground:#c6c6c6; --vscode-editorLineNumber-foreground:#858585; --vscode-editorLink-activeForeground:#4e94ce; --vscode-editorMarkerNavigation-background:#2d2d30; --vscode-editorMarkerNavigationError-background:#f48771; --vscode-editorMarkerNavigationInfo-background:#75beff; --vscode-editorMarkerNavigationWarning-background:#cca700; --vscode-editorOverviewRuler-addedForeground:rgba(0, 122, 204, 0.6); --vscode-editorOverviewRuler-border:rgba(127, 127, 127, 0.3); --vscode-editorOverviewRuler-bracketMatchForeground:#a0a0a0; --vscode-editorOverviewRuler-commonContentForeground:rgba(96, 96, 96, 0.4); --vscode-editorOverviewRuler-currentContentForeground:rgba(64, 200, 174, 0.5); --vscode-editorOverviewRuler-deletedForeground:rgba(0, 122, 204, 0.6); --vscode-editorOverviewRuler-errorForeground:rgba(255, 18, 18, 0.7); --vscode-editorOverviewRuler-findMatchForeground:rgba(209, 134, 22, 0.49); --vscode-editorOverviewRuler-incomingContentForeground:rgba(64, 166, 255, 0.5); --vscode-editorOverviewRuler-infoForeground:#75beff; --vscode-editorOverviewRuler-modifiedForeground:rgba(0, 122, 204, 0.6); --vscode-editorOverviewRuler-rangeHighlightForeground:rgba(0, 122, 204, 0.6); --vscode-editorOverviewRuler-selectionHighlightForeground:rgba(160, 160, 160, 0.8); --vscode-editorOverviewRuler-warningForeground:#cca700; --vscode-editorOverviewRuler-wordHighlightForeground:rgba(160, 160, 160, 0.8); --vscode-editorOverviewRuler-wordHighlightStrongForeground:rgba(192, 160, 192, 0.8); --vscode-editorPane-background:#1e1e1e; --vscode-editorRuler-foreground:#5a5a5a; --vscode-editorSuggestWidget-background:#252526; --vscode-editorSuggestWidget-border:#454545; --vscode-editorSuggestWidget-foreground:#d4d4d4; --vscode-editorSuggestWidget-highlightForeground:#0097fb; --vscode-editorSuggestWidget-selectedBackground:#062f4a; --vscode-editorUnnecessaryCode-opacity:rgba(0, 0, 0, 0.67); --vscode-editorWarning-foreground:#cca700; --vscode-editorWhitespace-foreground:rgba(227, 228, 226, 0.16); --vscode-editorWidget-background:#252526; --vscode-editorWidget-border:#454545; --vscode-editorWidget-foreground:#cccccc; --vscode-errorForeground:#f48771; --vscode-extensionBadge-remoteBackground:#007acc; --vscode-extensionBadge-remoteForeground:#ffffff; --vscode-extensionButton-prominentBackground:#327e36; --vscode-extensionButton-prominentForeground:#ffffff; --vscode-extensionButton-prominentHoverBackground:#28632b; --vscode-focusBorder:rgba(14, 99, 156, 0.8); --vscode-font-family:-apple-system, BlinkMacSystemFont, &quot;Segoe WPC&quot;, &quot;Segoe UI&quot;, &quot;Ubuntu&quot;, &quot;Droid Sans&quot;, sans-serif; --vscode-font-size:13px; --vscode-font-weight:normal; --vscode-foreground:#cccccc; --vscode-gitDecoration-addedResourceForeground:#81b88b; --vscode-gitDecoration-conflictingResourceForeground:#6c6cc4; --vscode-gitDecoration-deletedResourceForeground:#c74e39; --vscode-gitDecoration-ignoredResourceForeground:#8c8c8c; --vscode-gitDecoration-modifiedResourceForeground:#e2c08d; --vscode-gitDecoration-submoduleResourceForeground:#8db9e2; --vscode-gitDecoration-untrackedResourceForeground:#73c991; --vscode-gitlens-gutterBackgroundColor:rgba(255, 255, 255, 0.07); --vscode-gitlens-gutterForegroundColor:#bebebe; --vscode-gitlens-gutterUncommittedForegroundColor:rgba(0, 188, 242, 0.6); --vscode-gitlens-lineHighlightBackgroundColor:rgba(0, 188, 242, 0.2); --vscode-gitlens-lineHighlightOverviewRulerColor:rgba(0, 188, 242, 0.6); --vscode-gitlens-trailingLineBackgroundColor:rgba(0, 0, 0, 0); --vscode-gitlens-trailingLineForegroundColor:rgba(153, 153, 153, 0.35); --vscode-icon-foreground:#c5c5c5; --vscode-imagePreview-border:rgba(128, 128, 128, 0.35); --vscode-input-background:#3c3c3c; --vscode-input-foreground:#cccccc; --vscode-input-placeholderForeground:#a6a6a6; --vscode-inputOption-activeBackground:rgba(14, 99, 156, 0.4); --vscode-inputOption-activeBorder:rgba(0, 122, 204, 0); --vscode-inputValidation-errorBackground:#5a1d1d; --vscode-inputValidation-errorBorder:#be1100; --vscode-inputValidation-infoBackground:#063b49; --vscode-inputValidation-infoBorder:#007acc; --vscode-inputValidation-warningBackground:#352a05; --vscode-inputValidation-warningBorder:#b89500; --vscode-list-activeSelectionBackground:#094771; --vscode-list-activeSelectionForeground:#ffffff; --vscode-list-dropBackground:#383b3d; --vscode-list-errorForeground:#f88070; --vscode-list-filterMatchBackground:rgba(234, 92, 0, 0.33); --vscode-list-focusBackground:#062f4a; --vscode-list-highlightForeground:#0097fb; --vscode-list-hoverBackground:#2a2d2e; --vscode-list-inactiveSelectionBackground:#37373d; --vscode-list-invalidItemForeground:#b89500; --vscode-list-warningForeground:#cca700; --vscode-listFilterWidget-background:#653723; --vscode-listFilterWidget-noMatchesOutline:#be1100; --vscode-listFilterWidget-outline:rgba(0, 0, 0, 0); --vscode-menu-background:#252526; --vscode-menu-foreground:#cccccc; --vscode-menu-selectionBackground:#094771; --vscode-menu-selectionForeground:#ffffff; --vscode-menu-separatorBackground:#bbbbbb; --vscode-menubar-selectionBackground:rgba(255, 255, 255, 0.1); --vscode-menubar-selectionForeground:#cccccc; --vscode-merge-commonContentBackground:rgba(96, 96, 96, 0.16); --vscode-merge-commonHeaderBackground:rgba(96, 96, 96, 0.4); --vscode-merge-currentContentBackground:rgba(64, 200, 174, 0.2); --vscode-merge-currentHeaderBackground:rgba(64, 200, 174, 0.5); --vscode-merge-incomingContentBackground:rgba(64, 166, 255, 0.2); --vscode-merge-incomingHeaderBackground:rgba(64, 166, 255, 0.5); --vscode-minimap-findMatchHighlight:#d18616; --vscode-minimap-selectionHighlight:#264f78; --vscode-notificationCenterHeader-background:#303031; --vscode-notificationLink-foreground:#3794ff; --vscode-notifications-background:#252526; --vscode-notifications-border:#303031; --vscode-notifications-foreground:#cccccc; --vscode-notificationsErrorIcon-foreground:#f48771; --vscode-notificationsInfoIcon-foreground:#75beff; --vscode-notificationsWarningIcon-foreground:#cca700; --vscode-panel-background:#1e1e1e; --vscode-panel-border:rgba(128, 128, 128, 0.35); --vscode-panel-dropBackground:rgba(255, 255, 255, 0.12); --vscode-panelTitle-activeBorder:#e7e7e7; --vscode-panelTitle-activeForeground:#e7e7e7; --vscode-panelTitle-inactiveForeground:rgba(231, 231, 231, 0.6); --vscode-peekView-border:#007acc; --vscode-peekViewEditor-background:#001f33; --vscode-peekViewEditor-matchHighlightBackground:rgba(255, 143, 0, 0.6); --vscode-peekViewEditorGutter-background:#001f33; --vscode-peekViewResult-background:#252526; --vscode-peekViewResult-fileForeground:#ffffff; --vscode-peekViewResult-lineForeground:#bbbbbb; --vscode-peekViewResult-matchHighlightBackground:rgba(234, 92, 0, 0.3); --vscode-peekViewResult-selectionBackground:rgba(51, 153, 255, 0.2); --vscode-peekViewResult-selectionForeground:#ffffff; --vscode-peekViewTitle-background:#1e1e1e; --vscode-peekViewTitleDescription-foreground:rgba(204, 204, 204, 0.7); --vscode-peekViewTitleLabel-foreground:#ffffff; --vscode-pickerGroup-border:#3f3f46; --vscode-pickerGroup-foreground:#3794ff; --vscode-problemsErrorIcon-foreground:#f48771; --vscode-problemsInfoIcon-foreground:#75beff; --vscode-problemsWarningIcon-foreground:#cca700; --vscode-progressBar-background:#0e70c0; --vscode-quickInput-background:#252526; --vscode-scrollbar-shadow:#000000; --vscode-scrollbarSlider-activeBackground:rgba(191, 191, 191, 0.4); --vscode-scrollbarSlider-background:rgba(121, 121, 121, 0.4); --vscode-scrollbarSlider-hoverBackground:rgba(100, 100, 100, 0.7); --vscode-settings-checkboxBackground:#3c3c3c; --vscode-settings-checkboxBorder:#3c3c3c; --vscode-settings-checkboxForeground:#f0f0f0; --vscode-settings-dropdownBackground:#3c3c3c; --vscode-settings-dropdownBorder:#3c3c3c; --vscode-settings-dropdownForeground:#f0f0f0; --vscode-settings-dropdownListBorder:#454545; --vscode-settings-headerForeground:#e7e7e7; --vscode-settings-modifiedItemIndicator:#0c7d9d; --vscode-settings-numberInputBackground:#292929; --vscode-settings-numberInputForeground:#cccccc; --vscode-settings-textInputBackground:#292929; --vscode-settings-textInputForeground:#cccccc; --vscode-sideBar-background:#252526; --vscode-sideBar-dropBackground:rgba(255, 255, 255, 0.12); --vscode-sideBarSectionHeader-background:rgba(128, 128, 128, 0.2); --vscode-sideBarTitle-foreground:#bbbbbb; --vscode-statusBar-background:#007acc; --vscode-statusBar-debuggingBackground:#cc6633; --vscode-statusBar-debuggingForeground:#ffffff; --vscode-statusBar-foreground:#ffffff; --vscode-statusBar-noFolderBackground:#68217a; --vscode-statusBar-noFolderForeground:#ffffff; --vscode-statusBarItem-activeBackground:rgba(255, 255, 255, 0.18); --vscode-statusBarItem-hoverBackground:rgba(255, 255, 255, 0.12); --vscode-statusBarItem-prominentBackground:rgba(0, 0, 0, 0.5); --vscode-statusBarItem-prominentForeground:#ffffff; --vscode-statusBarItem-prominentHoverBackground:rgba(0, 0, 0, 0.3); --vscode-statusBarItem-remoteBackground:#16825d; --vscode-statusBarItem-remoteForeground:#ffffff; --vscode-symbolIcon-arrayForeground:#cccccc; --vscode-symbolIcon-booleanForeground:#cccccc; --vscode-symbolIcon-classForeground:#ee9d28; --vscode-symbolIcon-constructorForeground:#b180d7; --vscode-symbolIcon-contstantForeground:#cccccc; --vscode-symbolIcon-enumeratorForeground:#ee9d28; --vscode-symbolIcon-enumeratorMemberForeground:#75beff; --vscode-symbolIcon-eventForeground:#ee9d28; --vscode-symbolIcon-fieldForeground:#75beff; --vscode-symbolIcon-fileForeground:#cccccc; --vscode-symbolIcon-functionForeground:#b180d7; --vscode-symbolIcon-interfaceForeground:#75beff; --vscode-symbolIcon-keyForeground:#cccccc; --vscode-symbolIcon-methodForeground:#b180d7; --vscode-symbolIcon-moduleForeground:#cccccc; --vscode-symbolIcon-namespaceForeground:#cccccc; --vscode-symbolIcon-nullForeground:#cccccc; --vscode-symbolIcon-numberForeground:#cccccc; --vscode-symbolIcon-objectForeground:#cccccc; --vscode-symbolIcon-operatorForeground:#cccccc; --vscode-symbolIcon-packageForeground:#cccccc; --vscode-symbolIcon-propertyForeground:#cccccc; --vscode-symbolIcon-stringForeground:#cccccc; --vscode-symbolIcon-structForeground:#cccccc; --vscode-symbolIcon-typeParameterForeground:#cccccc; --vscode-symbolIcon-variableForeground:#75beff; --vscode-tab-activeBackground:#1e1e1e; --vscode-tab-activeForeground:#ffffff; --vscode-tab-activeModifiedBorder:#3399cc; --vscode-tab-border:#252526; --vscode-tab-inactiveBackground:#2d2d2d; --vscode-tab-inactiveForeground:rgba(255, 255, 255, 0.5); --vscode-tab-inactiveModifiedBorder:rgba(51, 153, 204, 0.5); --vscode-tab-unfocusedActiveBackground:#1e1e1e; --vscode-tab-unfocusedActiveForeground:rgba(255, 255, 255, 0.5); --vscode-tab-unfocusedActiveModifiedBorder:rgba(51, 153, 204, 0.5); --vscode-tab-unfocusedInactiveForeground:rgba(255, 255, 255, 0.25); --vscode-tab-unfocusedInactiveModifiedBorder:rgba(51, 153, 204, 0.25); --vscode-terminal-ansiBlack:#000000; --vscode-terminal-ansiBlue:#2472c8; --vscode-terminal-ansiBrightBlack:#666666; --vscode-terminal-ansiBrightBlue:#3b8eea; --vscode-terminal-ansiBrightCyan:#29b8db; --vscode-terminal-ansiBrightGreen:#23d18b; --vscode-terminal-ansiBrightMagenta:#d670d6; --vscode-terminal-ansiBrightRed:#f14c4c; --vscode-terminal-ansiBrightWhite:#e5e5e5; --vscode-terminal-ansiBrightYellow:#f5f543; --vscode-terminal-ansiCyan:#11a8cd; --vscode-terminal-ansiGreen:#0dbc79; --vscode-terminal-ansiMagenta:#bc3fbc; --vscode-terminal-ansiRed:#cd3131; --vscode-terminal-ansiWhite:#e5e5e5; --vscode-terminal-ansiYellow:#e5e510; --vscode-terminal-background:#1e1e1e; --vscode-terminal-border:rgba(128, 128, 128, 0.35); --vscode-terminal-foreground:#cccccc; --vscode-terminal-selectionBackground:rgba(255, 255, 255, 0.25); --vscode-textBlockQuote-background:rgba(127, 127, 127, 0.1); --vscode-textBlockQuote-border:rgba(0, 122, 204, 0.5); --vscode-textCodeBlock-background:rgba(10, 10, 10, 0.4); --vscode-textLink-activeForeground:#3794ff; --vscode-textLink-foreground:#3794ff; --vscode-textPreformat-foreground:#d7ba7d; --vscode-textSeparator-foreground:rgba(255, 255, 255, 0.18); --vscode-titleBar-activeBackground:#3c3c3c; --vscode-titleBar-activeForeground:#cccccc; --vscode-titleBar-inactiveBackground:rgba(60, 60, 60, 0.6); --vscode-titleBar-inactiveForeground:rgba(204, 204, 204, 0.6); --vscode-tree-indentGuidesStroke:#585858; --vscode-widget-shadow:#000000;
	body {
		background-color: var(--vscode-editor-background);
		color: var(--vscode-editor-foreground);
		font-family: var(--vscode-font-family);
		font-weight: var(--vscode-font-weight);
		font-size: var(--vscode-font-size);
		margin: 0;
		padding: 0 20px;
	}

	img {
		max-width: 100%;
		max-height: 100%;
	}

	a {
		color: var(--vscode-textLink-foreground);
	}

	a:hover {
		color: var(--vscode-textLink-activeForeground);
	}

	a:focus,
	input:focus,
	select:focus,
	textarea:focus {
		outline: 1px solid -webkit-focus-ring-color;
		outline-offset: -1px;
	}

	code {
		color: var(--vscode-textPreformat-foreground);
	}

	blockquote {
		background: var(--vscode-textBlockQuote-background);
		border-color: var(--vscode-textBlockQuote-border);
	}

	::-webkit-scrollbar {
		width: 10px;
		height: 10px;
	}

	::-webkit-scrollbar-thumb {
		background-color: var(--vscode-scrollbarSlider-background);
	}
	::-webkit-scrollbar-thumb:hover {
		background-color: var(--vscode-scrollbarSlider-hoverBackground);
	}
	::-webkit-scrollbar-thumb:active {
		background-color: var(--vscode-scrollbarSlider-activeBackground);
	}</style>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no">
                <meta http-equiv="Content-Security-Policy" content="img-src 'self' data: https: http: blob:; default-src 'unsafe-inline' 'unsafe-eval' vscode-resource: data: https: http: ws:;">
                <meta name="theme-color" content="#000000">
                <meta name="theme" content="${Identifiers.GeneratedThemeName}"/>
                <title>React App</title>

                <style type="text/css">
                ${style}
                </style>
            </head>
            <body>
                <noscript>You need to enable JavaScript to run this app.</noscript>
                <div id="root"></div>
                <script type="text/javascript">
                    function resolvePath(relativePath) {
                        if (relativePath && relativePath[0] == '.' && relativePath[1] != '.') {
                            return relativePath.substring(1);
                        }

                        return relativePath;
                    }
                    function getLocStrings() {
                        return ${locDatabase};
                    }
                    function getInitialSettings() {
                        return ${settingsString};
                    }
                </script>
            <script type="text/javascript" src="${path.basename(uri.fsPath)}"></script></body>
        </html>`;
    }
}
