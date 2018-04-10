/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @flow
 * @format
 */

import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {
  PythonDebuggerAttachTarget,
  RemoteDebugCommandRequest,
} from './RemoteDebuggerCommandService';
import typeof * as RemoteDebuggerCommandService from './RemoteDebuggerCommandService';

import {getDebuggerService} from 'nuclide-commons-atom/debugger';
import {observeAddedHostnames} from 'nuclide-commons-atom/projects';
import nuclideUri from 'nuclide-commons/nuclideUri';
import {fastDebounce} from 'nuclide-commons/observable';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {VspProcessInfo, VsAdapterTypes} from 'nuclide-debugger-common';
import {Observable} from 'rxjs';
import {track} from 'nuclide-commons/analytics';
import * as RemoteDebuggerCommandServiceLocal from './RemoteDebuggerCommandService';

let _rpcService: ?nuclide$RpcService = null;

export async function getPythonParLaunchProcessInfo(
  parPath: NuclideUri,
  args: Array<string>,
): Promise<VspProcessInfo> {
  return new VspProcessInfo(
    parPath,
    'launch',
    VsAdapterTypes.PYTHON,
    null,
    getPythonParConfig(parPath, args),
    {threads: true},
  );
}

function getPythonParConfig(parPath: NuclideUri, args: Array<string>): Object {
  const localParPath = nuclideUri.getPath(parPath);
  const cwd = nuclideUri.dirname(localParPath);
  return {
    stopOnEntry: false,
    console: 'none',
    // Will be replaced with the main module at runtime.
    program: '/dev/null',
    args,
    debugOptions: ['WaitOnAbnormalExit', 'WaitOnNormalExit', 'RedirectOutput'],
    pythonPath: localParPath,
    cwd,
  };
}

async function getPythonAttachTargetProcessInfo(
  targetRootUri: NuclideUri,
  target: PythonDebuggerAttachTarget,
): Promise<VspProcessInfo> {
  return new VspProcessInfo(
    targetRootUri,
    'attach',
    VsAdapterTypes.PYTHON,
    null,
    getPythonAttachTargetConfig(target),
    {threads: true},
  );
}

function getPythonAttachTargetConfig(
  target: PythonDebuggerAttachTarget,
): Object {
  return {
    localRoot: target.localRoot,
    remoteRoot: target.remoteRoot,
    port: target.port,
    host: '127.0.0.1',
  };
}

export function setRpcService(rpcService: nuclide$RpcService): IDisposable {
  _rpcService = rpcService;
  return new UniversalDisposable(() => {
    _rpcService = null;
  });
}

export function listenToRemoteDebugCommands(): IDisposable {
  const addedHostnames = observeAddedHostnames().startWith('local');

  const remoteDebuggerServices = addedHostnames.map(hostname => {
    const rootUri =
      hostname === 'local' ? '' : nuclideUri.createRemoteUri(hostname, '/');
    const service = getRemoteDebuggerCommandServiceByNuclideUri(rootUri);
    return {service, rootUri};
  });

  return new UniversalDisposable(
    remoteDebuggerServices
      .flatMap(({service, rootUri}) => {
        return service
          .observeAttachDebugTargets()
          .refCount()
          .map(targets => findDuplicateAttachTargetIds(targets));
      })

      .subscribe(duplicateTargetIds =>
        notifyDuplicateDebugTargets(duplicateTargetIds),
      ),
    remoteDebuggerServices
      .flatMap(({service, rootUri}) => {
        return service
          .observeRemoteDebugCommands()
          .refCount()
          .catch(error => {
            // eslint-disable-next-line no-console
            console.warn(
              'Failed to listen to remote debug commands - ' +
                'You could be running locally with two Atom windows. ' +
                `IsLocal: ${String(rootUri === '')}`,
            );
            return Observable.empty();
          })
          .map((command: RemoteDebugCommandRequest) => ({rootUri, command}));
      })
      .let(fastDebounce(500))
      .subscribe(async ({rootUri, command}) => {
        const attachProcessInfo = await getPythonAttachTargetProcessInfo(
          rootUri,
          command.target,
        );
        const debuggerService = await getDebuggerService();
        track('fb-python-debugger-auto-attach');
        debuggerService.startDebugging(attachProcessInfo);
        // Otherwise, we're already debugging that target.
      }),
  );
}

let shouldNotifyDuplicateTargets = true;
let duplicateTargetsNotification;

function notifyDuplicateDebugTargets(duplicateTargetIds: Set<string>): void {
  if (
    duplicateTargetIds.size > 0 &&
    shouldNotifyDuplicateTargets &&
    duplicateTargetsNotification == null
  ) {
    const formattedIds = Array.from(duplicateTargetIds).join(', ');
    duplicateTargetsNotification = atom.notifications.addInfo(
      `Debugger: duplicate attach targets: \`${formattedIds}\``,
      {
        buttons: [
          {
            onDidClick: () => {
              shouldNotifyDuplicateTargets = false;
              if (duplicateTargetsNotification != null) {
                duplicateTargetsNotification.dismiss();
              }
            },
            text: 'Ignore',
          },
        ],
        description:
          `Nuclide debugger detected duplicate attach targets with ids (${formattedIds}) ` +
          'That could be instagram running multiple processes - check out https://our.intern.facebook.com/intern/dex/instagram-server/debugging-with-nuclide/',
        dismissable: true,
      },
    );
    duplicateTargetsNotification.onDidDismiss(() => {
      duplicateTargetsNotification = null;
    });
  }
}

function findDuplicateAttachTargetIds(
  targets: Array<PythonDebuggerAttachTarget>,
): Set<string> {
  const targetIds = new Set();
  const duplicateTargetIds = new Set();
  targets.forEach(target => {
    const {id} = target;
    if (id == null) {
      return;
    }
    if (targetIds.has(id)) {
      duplicateTargetIds.add(id);
    } else {
      targetIds.add(id);
    }
  });
  return duplicateTargetIds;
}

export function getRemoteDebuggerCommandServiceByNuclideUri(
  uri: NuclideUri,
): RemoteDebuggerCommandService {
  if (_rpcService != null) {
    return _rpcService.getServiceByNuclideUri(
      'RemoteDebuggerCommandService',
      uri,
    );
  } else {
    return RemoteDebuggerCommandServiceLocal;
  }
}
