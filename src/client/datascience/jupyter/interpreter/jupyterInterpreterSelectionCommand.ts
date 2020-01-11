// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { inject, injectable } from 'inversify';
import { IExtensionSingleActivationService } from '../../../activation/types';
import { ICommandManager } from '../../../common/application/types';
import { IDisposableRegistry } from '../../../common/types';
import { JupyterInterpreterService } from './jupyterInterpreterService';

@injectable()
export class JupyterInterpreterSelectionCommand implements IExtensionSingleActivationService {
    constructor(
        @inject(JupyterInterpreterService) private readonly service: JupyterInterpreterService,
        @inject(ICommandManager) private readonly cmdManager: ICommandManager,
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry
    ) {}
    public async activate(): Promise<void> {
        this.disposables.push(this.cmdManager.registerCommand('python.datascience.selectJupyterInterpreter', this.service.selectInterpreter, this.service));
    }
}