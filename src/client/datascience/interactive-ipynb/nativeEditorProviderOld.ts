// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import { TextDocument, TextEditor, Uri } from 'vscode';

import {
    ICommandManager,
    ICustomEditorService,
    IDocumentManager,
    IWorkspaceService
} from '../../common/application/types';
import { JUPYTER_LANGUAGE } from '../../common/constants';
import { IFileSystem } from '../../common/platform/types';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry, Resource } from '../../common/types';
import { IServiceContainer } from '../../ioc/types';
import { Commands, Identifiers, Settings } from '../constants';
import { IDataScienceErrorHandler, INotebookEditor, INotebookServerOptions } from '../types';
import { NativeEditorProvider } from './nativeEditorProvider';

@injectable()
export class NativeEditorProviderOld extends NativeEditorProvider {
    public get activeEditor(): INotebookEditor | undefined {
        const active = [...this.activeEditors.entries()].find(e => e[1].active);
        if (active) {
            return active[1];
        }
    }

    public get editors(): INotebookEditor[] {
        return [...this.activeEditors.values()];
    }
    private activeEditors: Map<string, INotebookEditor> = new Map<string, INotebookEditor>();
    constructor(
        @inject(IServiceContainer) serviceContainer: IServiceContainer,
        @inject(IAsyncDisposableRegistry) asyncRegistry: IAsyncDisposableRegistry,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry,
        @inject(IWorkspaceService) workspace: IWorkspaceService,
        @inject(IConfigurationService) configuration: IConfigurationService,
        @inject(ICustomEditorService) customEditorService: ICustomEditorService,
        @inject(IFileSystem) private fileSystem: IFileSystem,
        @inject(IDocumentManager) private documentManager: IDocumentManager,
        @inject(ICommandManager) private readonly cmdManager: ICommandManager,
        @inject(IDataScienceErrorHandler) private dataScienceErrorHandler: IDataScienceErrorHandler
    ) {
        super(serviceContainer, asyncRegistry, disposables, workspace, configuration, customEditorService);

        // No live share sync required as open document from vscode will give us our contents.

        this.disposables.push(
            this.documentManager.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditorHandler.bind(this))
        );
        this.disposables.push(
            this.cmdManager.registerCommand(Commands.SaveNotebookNonCustomEditor, async (resource: Uri) => {
                await this.save(resource);
            })
        );
        this.disposables.push(
            this.cmdManager.registerCommand(
                Commands.SaveAsNotebookNonCustomEditor,
                async (resource: Uri, targetResource: Uri) => {
                    await this.saveAs(resource, targetResource);
                }
            )
        );

        // // Since we may have activated after a document was opened, also run open document for all documents.
        // // This needs to be async though. Iterating over all of these in the .ctor is crashing the extension
        // // host, so postpone till after the ctor is finished.
        // setTimeout(() => {
        //     if (this.documentManager.textDocuments && this.documentManager.textDocuments.forEach) {
        //         this.documentManager.textDocuments.forEach(doc => this.openNotebookAndCloseEditor(doc, false));
        //     }
        // }, 0);

        // // Reopen our list of files that were open during shutdown. Actually not doing this for now. The files
        // don't open until the extension loads and all they all steal focus.
        // const uriList = this.workspaceStorage.get<Uri[]>(NotebookUriListStorageKey);
        // if (uriList && uriList.length) {
        //     uriList.forEach(u => {
        //         this.fileSystem.readFile(u.fsPath).then(c => this.open(u, c).ignoreErrors()).ignoreErrors();
        //     });
        // }
    }

    public async open(file: Uri): Promise<INotebookEditor> {
        // See if this file is open or not already
        let editor = this.activeEditors.get(file.fsPath);
        if (!editor) {
            editor = await this.create(file);
            this.onOpenedEditor(editor);
        } else {
            await this.showEditor(editor);
        }
        return editor;
    }

    public async show(file: Uri): Promise<INotebookEditor | undefined> {
        // See if this file is open or not already
        const editor = this.activeEditors.get(file.fsPath);
        if (editor) {
            await this.showEditor(editor);
        }
        return editor;
    }

    public async getNotebookOptions(resource: Resource): Promise<INotebookServerOptions> {
        const settings = this.configuration.getSettings(resource);
        let serverURI: string | undefined = settings.datascience.jupyterServerURI;
        const useDefaultConfig: boolean | undefined = settings.datascience.useDefaultConfigForJupyter;

        // For the local case pass in our URI as undefined, that way connect doesn't have to check the setting
        if (serverURI.toLowerCase() === Settings.JupyterServerLocalLaunch) {
            serverURI = undefined;
        }

        return {
            enableDebugging: true,
            uri: serverURI,
            useDefaultConfig,
            purpose: Identifiers.HistoryPurpose // Share the same one as the interactive window. Just need a new session
        };
    }

    protected onOpenedEditor(e: INotebookEditor) {
        super.openedEditor(e);
        this.activeEditors.set(e.file.fsPath, e);
        this.disposables.push(e.saved(this.onSavedEditor.bind(this, e.file.fsPath)));
        this._onDidChangeActiveNotebookEditor.fire(this.activeEditor);
    }

    /**
     * Open ipynb files when user opens an ipynb file.
     *
     * @private
     * @memberof NativeEditorProvider
     */
    private onDidChangeActiveTextEditorHandler(editor?: TextEditor) {
        // I we're a source control diff view, then ignore this editor.
        if (!editor || this.isEditorPartOfDiffView(editor)) {
            return;
        }
        this.openNotebookAndCloseEditor(editor.document, true).ignoreErrors();
    }

    private async showEditor(editor: INotebookEditor) {
        await editor.show();
        this._onDidChangeActiveNotebookEditor.fire(this.activeEditor);
    }

    private async create(file: Uri): Promise<INotebookEditor> {
        const editor = await this.createNotebookEditor(file);
        this.disposables.push(editor.closed(this.onClosedEditor.bind(this)));
        await this.showEditor(editor);
        return editor;
    }

    private onClosedEditor(e: INotebookEditor) {
        this.activeEditors.delete(e.file.fsPath);
        this._onDidChangeActiveNotebookEditor.fire(this.activeEditor);
    }
    private onSavedEditor(oldPath: string, e: INotebookEditor) {
        // Switch our key for this editor
        if (this.activeEditors.has(oldPath)) {
            this.activeEditors.delete(oldPath);
        }
        this.activeEditors.set(e.file.fsPath, e);
    }

    private openNotebookAndCloseEditor = async (
        document: TextDocument,
        closeDocumentBeforeOpeningNotebook: boolean
    ) => {
        // See if this is an ipynb file
        if (this.isNotebook(document) && this.configuration.getSettings(document.uri).datascience.useNotebookEditor) {
            const closeActiveEditorCommand = 'workbench.action.closeActiveEditor';
            try {
                const uri = document.uri;

                if (closeDocumentBeforeOpeningNotebook) {
                    if (
                        !this.documentManager.activeTextEditor ||
                        this.documentManager.activeTextEditor.document !== document
                    ) {
                        await this.documentManager.showTextDocument(document);
                    }
                    await this.cmdManager.executeCommand(closeActiveEditorCommand);
                }

                // Open our own editor.
                await this.open(uri);

                if (!closeDocumentBeforeOpeningNotebook) {
                    // Then switch back to the ipynb and close it.
                    // If we don't do it in this order, the close will switch to the wrong item
                    await this.documentManager.showTextDocument(document);
                    await this.cmdManager.executeCommand(closeActiveEditorCommand);
                }
            } catch (e) {
                return this.dataScienceErrorHandler.handleError(e);
            }
        }
    };
    /**
     * Check if user is attempting to compare two ipynb files.
     * If yes, then return `true`, else `false`.
     *
     * @private
     * @param {TextEditor} editor
     * @memberof NativeEditorProvider
     */
    private isEditorPartOfDiffView(editor?: TextEditor) {
        if (!editor) {
            return false;
        }
        // There's no easy way to determine if the user is openeing a diff view.
        // One simple way is to check if there are 2 editor opened, and if both editors point to the same file
        // One file with the `file` scheme and the other with the `git` scheme.
        if (this.documentManager.visibleTextEditors.length <= 1) {
            return false;
        }

        // If we have both `git` & `file` schemes for the same file, then we're most likely looking at a diff view.
        // Also ensure both editors are in the same view column.
        // Possible we have a git diff view (with two editors git and file scheme), and we open the file view
        // on the side (different view column).
        const gitSchemeEditor = this.documentManager.visibleTextEditors.find(
            editorUri =>
                editorUri.document.uri.scheme === 'git' &&
                this.fileSystem.arePathsSame(editorUri.document.uri.fsPath, editor.document.uri.fsPath)
        );

        if (!gitSchemeEditor) {
            return false;
        }

        const fileSchemeEditor = this.documentManager.visibleTextEditors.find(
            editorUri =>
                editorUri.document.uri.scheme === 'file' &&
                this.fileSystem.arePathsSame(editorUri.document.uri.fsPath, editor.document.uri.fsPath) &&
                editorUri.viewColumn === gitSchemeEditor.viewColumn
        );
        if (!fileSchemeEditor) {
            return false;
        }

        // Also confirm the document we have passed in, belongs to one of the editors.
        // If its not, then its another document (that is not in the diff view).
        return gitSchemeEditor === editor || fileSchemeEditor === editor;
    }
    private isNotebook(document: TextDocument) {
        // Only support file uris (we don't want to automatically open any other ipynb file from another resource as a notebook).
        // E.g. when opening a document for comparison, the scheme is `git`, in live share the scheme is `vsls`.
        const validUriScheme = document.uri.scheme === 'file' || document.uri.scheme === 'vsls';
        return (
            validUriScheme &&
            (document.languageId === JUPYTER_LANGUAGE ||
                path.extname(document.fileName).toLocaleLowerCase() === '.ipynb')
        );
    }
}
