/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { IFileService, IFileContent, FileChangesEvent, FileOperationResult, FileOperationError } from 'vs/platform/files/common/files';
import { VSBuffer } from 'vs/base/common/buffer';
import { URI } from 'vs/base/common/uri';
import {
	SyncResource, SyncStatus, IUserData, IUserDataSyncStoreService, UserDataSyncErrorCode, UserDataSyncError, IUserDataSyncLogService, IUserDataSyncUtilService,
	IUserDataSyncResourceEnablementService, IUserDataSyncBackupStoreService, ISyncResourceHandle, USER_DATA_SYNC_SCHEME, ISyncResourcePreview as IBaseSyncResourcePreview,
	IUserDataManifest, ISyncData, IRemoteUserData, PREVIEW_DIR_NAME, IResourcePreview as IBaseResourcePreview, Change, MergeState
} from 'vs/platform/userDataSync/common/userDataSync';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { joinPath, dirname, isEqual, basename } from 'vs/base/common/resources';
import { CancelablePromise, RunOnceScheduler, createCancelablePromise } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ParseError, parse } from 'vs/base/common/json';
import { FormattingOptions } from 'vs/base/common/jsonFormatter';
import { IStringDictionary } from 'vs/base/common/collections';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { isString } from 'vs/base/common/types';
import { uppercaseFirstLetter } from 'vs/base/common/strings';
import { equals } from 'vs/base/common/arrays';
import { getServiceMachineId } from 'vs/platform/serviceMachineId/common/serviceMachineId';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IHeaders } from 'vs/base/parts/request/common/request';

type SyncSourceClassification = {
	source?: { classification: 'SystemMetaData', purpose: 'FeatureInsight', isMeasurement: true };
};

function isSyncData(thing: any): thing is ISyncData {
	if (thing
		&& (thing.version !== undefined && typeof thing.version === 'number')
		&& (thing.content !== undefined && typeof thing.content === 'string')) {

		// backward compatibility
		if (Object.keys(thing).length === 2) {
			return true;
		}

		if (Object.keys(thing).length === 3
			&& (thing.machineId !== undefined && typeof thing.machineId === 'string')) {
			return true;
		}
	}

	return false;
}

export interface IMergableResourcePreview extends IBaseResourcePreview {
	readonly remoteContent: string | null;
	readonly localContent: string | null;
	readonly previewContent: string | null;
	readonly acceptedContent: string | null;
	readonly hasConflicts: boolean;
}

export type IResourcePreview = Omit<IMergableResourcePreview, 'mergeState'>;

export interface ISyncResourcePreview extends IBaseSyncResourcePreview {
	readonly remoteUserData: IRemoteUserData;
	readonly lastSyncUserData: IRemoteUserData | null;
	readonly resourcePreviews: IMergableResourcePreview[];
}

export abstract class AbstractSynchroniser extends Disposable {

	private syncPreviewPromise: CancelablePromise<ISyncResourcePreview> | null = null;

	protected readonly syncFolder: URI;
	protected readonly syncPreviewFolder: URI;
	private readonly currentMachineIdPromise: Promise<string>;

	private _status: SyncStatus = SyncStatus.Idle;
	get status(): SyncStatus { return this._status; }
	private _onDidChangStatus: Emitter<SyncStatus> = this._register(new Emitter<SyncStatus>());
	readonly onDidChangeStatus: Event<SyncStatus> = this._onDidChangStatus.event;

	private _conflicts: IMergableResourcePreview[] = [];
	get conflicts(): IMergableResourcePreview[] { return this._conflicts; }
	private _onDidChangeConflicts: Emitter<IMergableResourcePreview[]> = this._register(new Emitter<IMergableResourcePreview[]>());
	readonly onDidChangeConflicts: Event<IMergableResourcePreview[]> = this._onDidChangeConflicts.event;

	private readonly localChangeTriggerScheduler = new RunOnceScheduler(() => this.doTriggerLocalChange(), 50);
	private readonly _onDidChangeLocal: Emitter<void> = this._register(new Emitter<void>());
	readonly onDidChangeLocal: Event<void> = this._onDidChangeLocal.event;

	protected readonly lastSyncResource: URI;
	protected readonly syncResourceLogLabel: string;

	private syncHeaders: IHeaders = {};

	constructor(
		readonly resource: SyncResource,
		@IFileService protected readonly fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IStorageService storageService: IStorageService,
		@IUserDataSyncStoreService protected readonly userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncBackupStoreService protected readonly userDataSyncBackupStoreService: IUserDataSyncBackupStoreService,
		@IUserDataSyncResourceEnablementService protected readonly userDataSyncResourceEnablementService: IUserDataSyncResourceEnablementService,
		@ITelemetryService protected readonly telemetryService: ITelemetryService,
		@IUserDataSyncLogService protected readonly logService: IUserDataSyncLogService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
	) {
		super();
		this.syncResourceLogLabel = uppercaseFirstLetter(this.resource);
		this.syncFolder = joinPath(environmentService.userDataSyncHome, resource);
		this.syncPreviewFolder = joinPath(this.syncFolder, PREVIEW_DIR_NAME);
		this.lastSyncResource = joinPath(this.syncFolder, `lastSync${this.resource}.json`);
		this.currentMachineIdPromise = getServiceMachineId(environmentService, fileService, storageService);
	}

	protected isEnabled(): boolean { return this.userDataSyncResourceEnablementService.isResourceEnabled(this.resource); }

	protected async triggerLocalChange(): Promise<void> {
		if (this.isEnabled()) {
			this.localChangeTriggerScheduler.schedule();
		}
	}

	protected async doTriggerLocalChange(): Promise<void> {

		// Sync again if current status is in conflicts
		if (this.status === SyncStatus.HasConflicts) {
			this.logService.info(`${this.syncResourceLogLabel}: In conflicts state and local change detected. Syncing again...`);
			const preview = await this.syncPreviewPromise!;
			this.syncPreviewPromise = null;
			const status = await this.performSync(preview.remoteUserData, preview.lastSyncUserData, true);
			this.setStatus(status);
		}

		// Check if local change causes remote change
		else {
			this.logService.trace(`${this.syncResourceLogLabel}: Checking for local changes...`);
			const lastSyncUserData = await this.getLastSyncUserData();
			const hasRemoteChanged = lastSyncUserData ? (await this.doGenerateSyncResourcePreview(lastSyncUserData, lastSyncUserData, true, CancellationToken.None)).resourcePreviews.some(({ remoteChange }) => remoteChange !== Change.None) : true;
			if (hasRemoteChanged) {
				this._onDidChangeLocal.fire();
			}
		}
	}

	protected setStatus(status: SyncStatus): void {
		if (this._status !== status) {
			const oldStatus = this._status;
			if (status === SyncStatus.HasConflicts) {
				// Log to telemetry when there is a sync conflict
				this.telemetryService.publicLog2<{ source: string }, SyncSourceClassification>('sync/conflictsDetected', { source: this.resource });
			}
			if (oldStatus === SyncStatus.HasConflicts && status === SyncStatus.Idle) {
				// Log to telemetry when conflicts are resolved
				this.telemetryService.publicLog2<{ source: string }, SyncSourceClassification>('sync/conflictsResolved', { source: this.resource });
			}
			this._status = status;
			this._onDidChangStatus.fire(status);
		}
	}

	async pull(): Promise<void> {
		if (!this.isEnabled()) {
			this.logService.info(`${this.syncResourceLogLabel}: Skipped pulling ${this.syncResourceLogLabel.toLowerCase()} as it is disabled.`);
			return;
		}

		await this.stop();

		try {
			this.logService.info(`${this.syncResourceLogLabel}: Started pulling ${this.syncResourceLogLabel.toLowerCase()}...`);
			this.setStatus(SyncStatus.Syncing);

			const lastSyncUserData = await this.getLastSyncUserData();
			const remoteUserData = await this.getRemoteUserData(lastSyncUserData);
			const preview = await this.generatePullPreview(remoteUserData, lastSyncUserData, CancellationToken.None);

			await this.applyPreview(remoteUserData, lastSyncUserData, preview, false);
			this.logService.info(`${this.syncResourceLogLabel}: Finished pulling ${this.syncResourceLogLabel.toLowerCase()}.`);
		} finally {
			this.setStatus(SyncStatus.Idle);
		}
	}

	async push(): Promise<void> {
		if (!this.isEnabled()) {
			this.logService.info(`${this.syncResourceLogLabel}: Skipped pushing ${this.syncResourceLogLabel.toLowerCase()} as it is disabled.`);
			return;
		}

		this.stop();

		try {
			this.logService.info(`${this.syncResourceLogLabel}: Started pushing ${this.syncResourceLogLabel.toLowerCase()}...`);
			this.setStatus(SyncStatus.Syncing);

			const lastSyncUserData = await this.getLastSyncUserData();
			const remoteUserData = await this.getRemoteUserData(lastSyncUserData);
			const preview = await this.generatePushPreview(remoteUserData, lastSyncUserData, CancellationToken.None);

			await this.applyPreview(remoteUserData, lastSyncUserData, preview, true);
			this.logService.info(`${this.syncResourceLogLabel}: Finished pushing ${this.syncResourceLogLabel.toLowerCase()}.`);

		} finally {
			this.setStatus(SyncStatus.Idle);
		}
	}

	async sync(manifest: IUserDataManifest | null, headers: IHeaders = {}): Promise<void> {
		await this._sync(manifest, true, headers);
	}

	async preview(manifest: IUserDataManifest | null, headers: IHeaders = {}): Promise<ISyncResourcePreview | null> {
		return this._sync(manifest, false, headers);
	}

	async apply(force: boolean, headers: IHeaders = {}): Promise<ISyncResourcePreview | null> {
		try {
			this.syncHeaders = { ...headers };

			const status = await this.doApply(force);
			this.setStatus(status);

			return this.syncPreviewPromise;
		} finally {
			this.syncHeaders = {};
		}
	}

	private async _sync(manifest: IUserDataManifest | null, apply: boolean, headers: IHeaders): Promise<ISyncResourcePreview | null> {
		try {
			this.syncHeaders = { ...headers };

			if (!this.isEnabled()) {
				if (this.status !== SyncStatus.Idle) {
					await this.stop();
				}
				this.logService.info(`${this.syncResourceLogLabel}: Skipped synchronizing ${this.resource.toLowerCase()} as it is disabled.`);
				return null;
			}

			if (this.status === SyncStatus.HasConflicts) {
				this.logService.info(`${this.syncResourceLogLabel}: Skipped synchronizing ${this.resource.toLowerCase()} as there are conflicts.`);
				return this.syncPreviewPromise;
			}

			if (this.status === SyncStatus.Syncing) {
				this.logService.info(`${this.syncResourceLogLabel}: Skipped synchronizing ${this.resource.toLowerCase()} as it is running already.`);
				return this.syncPreviewPromise;
			}

			this.logService.trace(`${this.syncResourceLogLabel}: Started synchronizing ${this.resource.toLowerCase()}...`);
			this.setStatus(SyncStatus.Syncing);

			let status: SyncStatus = SyncStatus.Idle;
			try {
				const lastSyncUserData = await this.getLastSyncUserData();
				const remoteUserData = await this.getLatestRemoteUserData(manifest, lastSyncUserData);
				status = await this.performSync(remoteUserData, lastSyncUserData, apply);
				if (status === SyncStatus.HasConflicts) {
					this.logService.info(`${this.syncResourceLogLabel}: Detected conflicts while synchronizing ${this.resource.toLowerCase()}.`);
				} else if (status === SyncStatus.Idle) {
					this.logService.trace(`${this.syncResourceLogLabel}: Finished synchronizing ${this.resource.toLowerCase()}.`);
				}
				return this.syncPreviewPromise || null;
			} finally {
				this.setStatus(status);
			}
		} finally {
			this.syncHeaders = {};
		}
	}

	async replace(uri: URI): Promise<boolean> {
		const content = await this.resolveContent(uri);
		if (!content) {
			return false;
		}

		const syncData = this.parseSyncData(content);
		if (!syncData) {
			return false;
		}

		await this.stop();

		try {
			this.logService.trace(`${this.syncResourceLogLabel}: Started resetting ${this.resource.toLowerCase()}...`);
			this.setStatus(SyncStatus.Syncing);
			const lastSyncUserData = await this.getLastSyncUserData();
			const remoteUserData = await this.getLatestRemoteUserData(null, lastSyncUserData);
			const preview = await this.generateReplacePreview(syncData, remoteUserData, lastSyncUserData);
			await this.applyPreview(remoteUserData, lastSyncUserData, preview, false);
			this.logService.info(`${this.syncResourceLogLabel}: Finished resetting ${this.resource.toLowerCase()}.`);
		} finally {
			this.setStatus(SyncStatus.Idle);
		}

		return true;
	}

	protected async getLatestRemoteUserData(manifest: IUserDataManifest | null, lastSyncUserData: IRemoteUserData | null): Promise<IRemoteUserData> {
		if (lastSyncUserData) {

			const latestRef = manifest && manifest.latest ? manifest.latest[this.resource] : undefined;

			// Last time synced resource and latest resource on server are same
			if (lastSyncUserData.ref === latestRef) {
				return lastSyncUserData;
			}

			// There is no resource on server and last time it was synced with no resource
			if (latestRef === undefined && lastSyncUserData.syncData === null) {
				return lastSyncUserData;
			}
		}
		return this.getRemoteUserData(lastSyncUserData);
	}

	private async performSync(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, apply: boolean): Promise<SyncStatus> {
		if (remoteUserData.syncData && remoteUserData.syncData.version > this.version) {
			// current version is not compatible with cloud version
			this.telemetryService.publicLog2<{ source: string }, SyncSourceClassification>('sync/incompatible', { source: this.resource });
			throw new UserDataSyncError(localize({ key: 'incompatible', comment: ['This is an error while syncing a resource that its local version is not compatible with its remote version.'] }, "Cannot sync {0} as its local version {1} is not compatible with its remote version {2}", this.resource, this.version, remoteUserData.syncData.version), UserDataSyncErrorCode.IncompatibleLocalContent, this.resource);
		}

		try {
			return await this.doSync(remoteUserData, lastSyncUserData, apply);
		} catch (e) {
			if (e instanceof UserDataSyncError) {
				switch (e.code) {

					case UserDataSyncErrorCode.LocalPreconditionFailed:
						// Rejected as there is a new local version. Syncing again...
						this.logService.info(`${this.syncResourceLogLabel}: Failed to synchronize ${this.syncResourceLogLabel} as there is a new local version available. Synchronizing again...`);
						return this.performSync(remoteUserData, lastSyncUserData, apply);

					case UserDataSyncErrorCode.PreconditionFailed:
						// Rejected as there is a new remote version. Syncing again...
						this.logService.info(`${this.syncResourceLogLabel}: Failed to synchronize as there is a new remote version available. Synchronizing again...`);

						// Avoid cache and get latest remote user data - https://github.com/microsoft/vscode/issues/90624
						remoteUserData = await this.getRemoteUserData(null);

						// Get the latest last sync user data. Because multiples parallel syncs (in Web) could share same last sync data
						// and one of them successfully updated remote and last sync state.
						lastSyncUserData = await this.getLastSyncUserData();

						return this.performSync(remoteUserData, lastSyncUserData, apply);
				}
			}
			throw e;
		}
	}

	protected async doSync(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, apply: boolean): Promise<SyncStatus> {
		try {
			// generate or use existing preview
			if (!this.syncPreviewPromise) {
				this.syncPreviewPromise = createCancelablePromise(token => this.doGenerateSyncResourcePreview(remoteUserData, lastSyncUserData, apply, token));
			}

			const preview = await this.syncPreviewPromise;
			this.updateConflicts(preview.resourcePreviews);
			if (preview.resourcePreviews.some(({ mergeState }) => mergeState === MergeState.Conflict)) {
				return SyncStatus.HasConflicts;
			}

			if (apply) {
				return await this.doApply(false);
			}

			return SyncStatus.Syncing;

		} catch (error) {

			// reset preview on error
			this.syncPreviewPromise = null;

			throw error;
		}
	}

	async accept(resource: URI, content: string): Promise<ISyncResourcePreview | null> {
		await this.updateSyncResourcePreview(resource, async (resourcePreview) => {
			const updatedResourcePreview = await this.updateResourcePreview(resourcePreview, resource, content);
			return {
				...updatedResourcePreview,
				mergeState: MergeState.Accepted
			};
		});
		return this.syncPreviewPromise;
	}

	async merge(resource: URI): Promise<ISyncResourcePreview | null> {
		await this.updateSyncResourcePreview(resource, async (resourcePreview) => ({
			...resourcePreview,
			mergeState: resourcePreview.hasConflicts ? MergeState.Conflict : MergeState.Accepted
		}));
		return this.syncPreviewPromise;
	}

	async discard(resource: URI): Promise<ISyncResourcePreview | null> {
		await this.updateSyncResourcePreview(resource, async (resourcePreview) => {
			await this.fileService.writeFile(resourcePreview.previewResource, VSBuffer.fromString(resourcePreview.previewContent || ''));
			const updatedPreview = await this.updateResourcePreview(resourcePreview, resourcePreview.previewResource, resourcePreview.previewContent || '');
			return {
				...updatedPreview,
				mergeState: MergeState.Preview
			};
		});
		return this.syncPreviewPromise;
	}

	private async updateSyncResourcePreview(resource: URI, updateResourcePreview: (resourcePreview: IMergableResourcePreview) => Promise<IMergableResourcePreview>): Promise<void> {
		if (!this.syncPreviewPromise) {
			return;
		}

		let preview = await this.syncPreviewPromise;
		const index = preview.resourcePreviews.findIndex(({ localResource, remoteResource, previewResource }) =>
			isEqual(localResource, resource) || isEqual(remoteResource, resource) || isEqual(previewResource, resource));
		if (index === -1) {
			return;
		}

		this.syncPreviewPromise = createCancelablePromise(async token => {
			const resourcePreviews = [...preview.resourcePreviews];
			resourcePreviews[index] = await updateResourcePreview(resourcePreviews[index]);
			return {
				...preview,
				resourcePreviews
			};
		});

		preview = await this.syncPreviewPromise;
		this.updateConflicts(preview.resourcePreviews);
		if (preview.resourcePreviews.some(({ mergeState }) => mergeState === MergeState.Conflict)) {
			this.setStatus(SyncStatus.HasConflicts);
		} else {
			this.setStatus(SyncStatus.Syncing);
		}
	}

	protected async updateResourcePreview(resourcePreview: IResourcePreview, resource: URI, acceptedContent: string): Promise<IResourcePreview> {
		return {
			...resourcePreview,
			acceptedContent
		};
	}

	private async doApply(force: boolean): Promise<SyncStatus> {
		if (!this.syncPreviewPromise) {
			return SyncStatus.Idle;
		}

		const preview = await this.syncPreviewPromise;

		// check for conflicts
		if (preview.resourcePreviews.some(({ mergeState }) => mergeState === MergeState.Conflict)) {
			return SyncStatus.HasConflicts;
		}

		// check if all are accepted
		if (preview.resourcePreviews.some(({ mergeState }) => mergeState !== MergeState.Accepted)) {
			return SyncStatus.Syncing;
		}

		// apply preview
		await this.applyPreview(preview.remoteUserData, preview.lastSyncUserData, preview.resourcePreviews, force);

		// reset preview
		this.syncPreviewPromise = null;

		// reset preview folder
		await this.clearPreviewFolder();

		return SyncStatus.Idle;
	}

	private async clearPreviewFolder(): Promise<void> {
		try {
			await this.fileService.del(this.syncPreviewFolder, { recursive: true });
		} catch (error) { /* Ignore */ }
	}

	private updateConflicts(previews: IMergableResourcePreview[]): void {
		const conflicts = previews.filter(p => p.mergeState === MergeState.Conflict);
		if (!equals(this._conflicts, conflicts, (a, b) => isEqual(a.previewResource, b.previewResource))) {
			this._conflicts = conflicts;
			this._onDidChangeConflicts.fire(conflicts);
		}
	}

	async hasPreviouslySynced(): Promise<boolean> {
		const lastSyncData = await this.getLastSyncUserData();
		return !!lastSyncData;
	}

	async getRemoteSyncResourceHandles(): Promise<ISyncResourceHandle[]> {
		const handles = await this.userDataSyncStoreService.getAllRefs(this.resource);
		return handles.map(({ created, ref }) => ({ created, uri: this.toRemoteBackupResource(ref) }));
	}

	async getLocalSyncResourceHandles(): Promise<ISyncResourceHandle[]> {
		const handles = await this.userDataSyncBackupStoreService.getAllRefs(this.resource);
		return handles.map(({ created, ref }) => ({ created, uri: this.toLocalBackupResource(ref) }));
	}

	private toRemoteBackupResource(ref: string): URI {
		return URI.from({ scheme: USER_DATA_SYNC_SCHEME, authority: 'remote-backup', path: `/${this.resource}/${ref}` });
	}

	private toLocalBackupResource(ref: string): URI {
		return URI.from({ scheme: USER_DATA_SYNC_SCHEME, authority: 'local-backup', path: `/${this.resource}/${ref}` });
	}

	async getMachineId({ uri }: ISyncResourceHandle): Promise<string | undefined> {
		const ref = basename(uri);
		if (isEqual(uri, this.toRemoteBackupResource(ref))) {
			const { content } = await this.getUserData(ref);
			if (content) {
				const syncData = this.parseSyncData(content);
				return syncData?.machineId;
			}
		}
		return undefined;
	}

	async resolveContent(uri: URI): Promise<string | null> {
		const ref = basename(uri);
		if (isEqual(uri, this.toRemoteBackupResource(ref))) {
			const { content } = await this.getUserData(ref);
			return content;
		}
		if (isEqual(uri, this.toLocalBackupResource(ref))) {
			return this.userDataSyncBackupStoreService.resolveContent(this.resource, ref);
		}
		return null;
	}

	protected async resolvePreviewContent(uri: URI): Promise<string | null> {
		const syncPreview = this.syncPreviewPromise ? await this.syncPreviewPromise : null;
		if (syncPreview) {
			for (const resourcePreview of syncPreview.resourcePreviews) {
				if (isEqual(resourcePreview.acceptedResource, uri)) {
					return resourcePreview.acceptedContent || '';
				}
				if (isEqual(resourcePreview.remoteResource, uri)) {
					return resourcePreview.remoteContent || '';
				}
				if (isEqual(resourcePreview.localResource, uri)) {
					return resourcePreview.localContent || '';
				}
			}
		}
		return null;
	}

	async resetLocal(): Promise<void> {
		try {
			await this.fileService.del(this.lastSyncResource);
		} catch (e) { /* ignore */ }
	}

	private async doGenerateSyncResourcePreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, apply: boolean, token: CancellationToken): Promise<ISyncResourcePreview> {
		const machineId = await this.currentMachineIdPromise;
		const isLastSyncFromCurrentMachine = !!remoteUserData.syncData?.machineId && remoteUserData.syncData.machineId === machineId;

		// For preview, use remoteUserData if lastSyncUserData does not exists and last sync is from current machine
		const lastSyncUserDataForPreview = lastSyncUserData === null && isLastSyncFromCurrentMachine ? remoteUserData : lastSyncUserData;
		const result = await this.generateSyncPreview(remoteUserData, lastSyncUserDataForPreview, token);

		const resourcePreviews: IMergableResourcePreview[] = [];
		for (const resourcePreview of result) {
			if (token.isCancellationRequested) {
				break;
			}
			if (!apply) {
				await this.fileService.writeFile(resourcePreview.previewResource, VSBuffer.fromString(resourcePreview.previewContent || ''));
			}
			resourcePreviews.push({
				...resourcePreview,
				mergeState: resourcePreview.localChange === Change.None && resourcePreview.remoteChange === Change.None ? MergeState.Accepted /* Mark previews with no changes as merged */
					: apply ? (resourcePreview.hasConflicts ? MergeState.Conflict : MergeState.Accepted)
						: MergeState.Preview
			});
		}

		return { remoteUserData, lastSyncUserData, resourcePreviews, isLastSyncFromCurrentMachine };
	}

	async getLastSyncUserData<T extends IRemoteUserData>(): Promise<T | null> {
		try {
			const content = await this.fileService.readFile(this.lastSyncResource);
			const parsed = JSON.parse(content.value.toString());
			const userData: IUserData = parsed as IUserData;
			if (userData.content === null) {
				return { ref: parsed.ref, syncData: null } as T;
			}
			const syncData: ISyncData = JSON.parse(userData.content);

			/* Check if syncData is of expected type. Return only if matches */
			if (isSyncData(syncData)) {
				return { ...parsed, ...{ syncData, content: undefined } };
			}

		} catch (error) {
			if (!(error instanceof FileOperationError && error.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				// log error always except when file does not exist
				this.logService.error(error);
			}
		}
		return null;
	}

	protected async updateLastSyncUserData(lastSyncRemoteUserData: IRemoteUserData, additionalProps: IStringDictionary<any> = {}): Promise<void> {
		const lastSyncUserData: IUserData = { ref: lastSyncRemoteUserData.ref, content: lastSyncRemoteUserData.syncData ? JSON.stringify(lastSyncRemoteUserData.syncData) : null, ...additionalProps };
		await this.fileService.writeFile(this.lastSyncResource, VSBuffer.fromString(JSON.stringify(lastSyncUserData)));
	}

	async getRemoteUserData(lastSyncData: IRemoteUserData | null): Promise<IRemoteUserData> {
		const { ref, content } = await this.getUserData(lastSyncData);
		let syncData: ISyncData | null = null;
		if (content !== null) {
			syncData = this.parseSyncData(content);
		}
		return { ref, syncData };
	}

	protected parseSyncData(content: string): ISyncData {
		try {
			const syncData: ISyncData = JSON.parse(content);
			if (isSyncData(syncData)) {
				return syncData;
			}
		} catch (error) {
			this.logService.error(error);
		}
		throw new UserDataSyncError(localize('incompatible sync data', "Cannot parse sync data as it is not compatible with current version."), UserDataSyncErrorCode.IncompatibleRemoteContent, this.resource);
	}

	private async getUserData(refOrLastSyncData: string | IRemoteUserData | null): Promise<IUserData> {
		if (isString(refOrLastSyncData)) {
			const content = await this.userDataSyncStoreService.resolveContent(this.resource, refOrLastSyncData);
			return { ref: refOrLastSyncData, content };
		} else {
			const lastSyncUserData: IUserData | null = refOrLastSyncData ? { ref: refOrLastSyncData.ref, content: refOrLastSyncData.syncData ? JSON.stringify(refOrLastSyncData.syncData) : null } : null;
			return this.userDataSyncStoreService.read(this.resource, lastSyncUserData, this.syncHeaders);
		}
	}

	protected async updateRemoteUserData(content: string, ref: string | null): Promise<IRemoteUserData> {
		const machineId = await this.currentMachineIdPromise;
		const syncData: ISyncData = { version: this.version, machineId, content };
		ref = await this.userDataSyncStoreService.write(this.resource, JSON.stringify(syncData), ref, this.syncHeaders);
		return { ref, syncData };
	}

	protected async backupLocal(content: string): Promise<void> {
		const syncData: ISyncData = { version: this.version, content };
		return this.userDataSyncBackupStoreService.backup(this.resource, JSON.stringify(syncData));
	}

	async stop(): Promise<void> {
		if (this.status === SyncStatus.Idle) {
			return;
		}

		this.logService.trace(`${this.syncResourceLogLabel}: Stopping synchronizing ${this.resource.toLowerCase()}.`);
		if (this.syncPreviewPromise) {
			this.syncPreviewPromise.cancel();
			this.syncPreviewPromise = null;
		}

		this.updateConflicts([]);
		await this.clearPreviewFolder();

		this.setStatus(SyncStatus.Idle);
		this.logService.info(`${this.syncResourceLogLabel}: Stopped synchronizing ${this.resource.toLowerCase()}.`);
	}

	protected abstract readonly version: number;
	protected abstract generatePullPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, token: CancellationToken): Promise<IResourcePreview[]>;
	protected abstract generatePushPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, token: CancellationToken): Promise<IResourcePreview[]>;
	protected abstract generateReplacePreview(syncData: ISyncData, remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null): Promise<IResourcePreview[]>;
	protected abstract generateSyncPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, token: CancellationToken): Promise<IResourcePreview[]>;
	protected abstract applyPreview(remoteUserData: IRemoteUserData, lastSyncUserData: IRemoteUserData | null, resourcePreviews: IResourcePreview[], forcePush: boolean): Promise<void>;
}

export interface IFileResourcePreview extends IResourcePreview {
	readonly fileContent: IFileContent | null;
}

export abstract class AbstractFileSynchroniser extends AbstractSynchroniser {

	constructor(
		protected readonly file: URI,
		resource: SyncResource,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IStorageService storageService: IStorageService,
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncBackupStoreService userDataSyncBackupStoreService: IUserDataSyncBackupStoreService,
		@IUserDataSyncResourceEnablementService userDataSyncResourceEnablementService: IUserDataSyncResourceEnablementService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(resource, fileService, environmentService, storageService, userDataSyncStoreService, userDataSyncBackupStoreService, userDataSyncResourceEnablementService, telemetryService, logService, configurationService);
		this._register(this.fileService.watch(dirname(file)));
		this._register(this.fileService.onDidFilesChange(e => this.onFileChanges(e)));
	}

	protected async getLocalFileContent(): Promise<IFileContent | null> {
		try {
			return await this.fileService.readFile(this.file);
		} catch (error) {
			return null;
		}
	}

	protected async updateLocalFileContent(newContent: string, oldContent: IFileContent | null, force: boolean): Promise<void> {
		try {
			if (oldContent) {
				// file exists already
				await this.fileService.writeFile(this.file, VSBuffer.fromString(newContent), force ? undefined : oldContent);
			} else {
				// file does not exist
				await this.fileService.createFile(this.file, VSBuffer.fromString(newContent), { overwrite: force });
			}
		} catch (e) {
			if ((e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) ||
				(e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_MODIFIED_SINCE)) {
				throw new UserDataSyncError(e.message, UserDataSyncErrorCode.LocalPreconditionFailed);
			} else {
				throw e;
			}
		}
	}

	private onFileChanges(e: FileChangesEvent): void {
		if (!e.contains(this.file)) {
			return;
		}
		this.triggerLocalChange();
	}

}

export abstract class AbstractJsonFileSynchroniser extends AbstractFileSynchroniser {

	constructor(
		file: URI,
		resource: SyncResource,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IStorageService storageService: IStorageService,
		@IUserDataSyncStoreService userDataSyncStoreService: IUserDataSyncStoreService,
		@IUserDataSyncBackupStoreService userDataSyncBackupStoreService: IUserDataSyncBackupStoreService,
		@IUserDataSyncResourceEnablementService userDataSyncResourceEnablementService: IUserDataSyncResourceEnablementService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IUserDataSyncLogService logService: IUserDataSyncLogService,
		@IUserDataSyncUtilService protected readonly userDataSyncUtilService: IUserDataSyncUtilService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(file, resource, fileService, environmentService, storageService, userDataSyncStoreService, userDataSyncBackupStoreService, userDataSyncResourceEnablementService, telemetryService, logService, configurationService);
	}

	protected hasErrors(content: string): boolean {
		const parseErrors: ParseError[] = [];
		parse(content, parseErrors, { allowEmptyContent: true, allowTrailingComma: true });
		return parseErrors.length > 0;
	}

	private _formattingOptions: Promise<FormattingOptions> | undefined = undefined;
	protected getFormattingOptions(): Promise<FormattingOptions> {
		if (!this._formattingOptions) {
			this._formattingOptions = this.userDataSyncUtilService.resolveFormattingOptions(this.file);
		}
		return this._formattingOptions;
	}

}
