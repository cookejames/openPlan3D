<script lang="ts">
  import { t, locale, translate, type Locale } from '$lib/i18n';
  import { projectServiceMessage } from '$lib/i18n/projectServiceMessages';
  import { templateLabels } from '$lib/i18n/templateLabels';
  import { modalDialog, reconcileNativeClose } from '$lib/utils/modalDialog';
  import { onMount, onDestroy, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { base } from '$app/paths';
  import { storageErrorMessage, downloadLibraryBackup } from '$lib/services/datastore';
  import { projectStore } from '$lib/services/projectStore';
  import { authState } from '$lib/stores/auth';
  import { openProject } from '$lib/services/projectOpening';
  import { createDefaultProject } from '$lib/stores/project';
  import WelcomeScreen from '$lib/components/WelcomeScreen.svelte';
  import LibraryRestoreDialog from '$lib/components/LibraryRestoreDialog.svelte';
  import ProjectPackageDialog from '$lib/components/ProjectPackageDialog.svelte';
  import LibraryStorageNote from '$lib/components/LibraryStorageNote.svelte';
  import AccountButton from '$lib/components/AccountButton.svelte';
  import ProjectActionsMenu from '$lib/components/ProjectActionsMenu.svelte';
  import SyncBadge from '$lib/components/SyncBadge.svelte';
  import { houseTemplates } from '$lib/utils/houseTemplates';

  const openingLifetime = new AbortController();
  onDestroy(() => openingLifetime.abort());

  // Same link as USER_GUIDE_URL in $lib/stores/exportNotice, which would pull the editor's export code into this page.
  const USER_GUIDE_URL = 'https://github.com/laanlabs/openPlan3D/blob/main/docs/user-guide.md';

  let projects = $state<{ id: string; name: string; updatedAt: string }[]>([]);
  let thumbnails = $state<Record<string, string | null>>({});
  let showWelcome = $state(false);
  let restoreOpen = $state(false);
  let restoreFile = $state.raw<File | null>(null);
  let packageOpen = $state(false);
  let loading = $state(true);
  let actionDialog = $state<{ type: 'rename' | 'delete'; id: string; name: string } | null>(null);
  let renameValue = $state('');
  let actionError = $state<string | null>(null);
  let actionBusy = $state(false);
  let duplicating = $state(false);
  let newProjectButton = $state<HTMLButtonElement>();
  let showTemplateModal = $state(false);

  let libraryError = $state<string | null>(null);

  // Cloud sync: badges, uploads and the one-time upload prompt. Only shown while signed in.
  const syncStatus = projectStore.syncStatus;
  const signedIn = $derived($authState.status === 'signedIn');
  const localProjects = $derived(signedIn ? projects.filter(project => $syncStatus[project.id] === 'local') : []);
  let syncUid = $state<string | null>(null);
  let promptDismissed = $state(false);
  let uploadingId = $state<string | null>(null);
  let uploadBusy = $state(false);
  let uploadRun = $state<{ done: number; total: number; failed: number } | null>(null);
  let syncError = $state<string | null>(null);

  async function withLibraryError(action: () => Promise<void>) {
    try { await action(); libraryError = null; }
    catch (error) { libraryError = storageErrorMessage(error); }
  }

  async function backupLibrary() {
    try { await downloadLibraryBackup(); }
    catch (error) { libraryError = storageErrorMessage(error); }
  }

  let refreshSeq = 0;
  async function refreshProjects() {
    const seq = ++refreshSeq;
    loading = true;
    try {
      const rows = await projectStore.list();
      // A newer refresh (for example the one after sign-in) supersedes this one, so an older list cannot overwrite it.
      if (seq !== refreshSeq) return;
      rows.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      projects = rows;
      const nextThumbnails = await projectStore.getThumbnails();
      if (seq !== refreshSeq) return;
      thumbnails = nextThumbnails;
    } finally { if (seq === refreshSeq) loading = false; }
  }

  function promptStorageKey(uid: string) { return `o3d_cloud_upload_prompt_dismissed:${uid}`; }
  function readPromptDismissed(uid: string): boolean {
    try { return localStorage.getItem(promptStorageKey(uid)) === '1'; } catch { return false; }
  }
  function persistPromptDismissal() {
    promptDismissed = true;
    if (!syncUid) return;
    try { localStorage.setItem(promptStorageKey(syncUid), '1'); } catch { /* the prompt may show again in this browser */ }
  }
  function dismissPrompt() { persistPromptDismissal(); uploadRun = null; }

  /** Sends local projects one at a time; a failure is counted and the run goes on. */
  async function uploadAll() {
    if (uploadBusy) return;
    const ids = localProjects.map(project => project.id);
    if (ids.length === 0) return;
    persistPromptDismissal();
    uploadBusy = true; syncError = null;
    let failed = 0;
    uploadRun = { done: 0, total: ids.length, failed };
    for (const [index, id] of ids.entries()) {
      uploadingId = id;
      try { await projectStore.uploadToCloud(id); }
      catch { failed += 1; }
      uploadRun = { done: index + 1, total: ids.length, failed };
    }
    uploadingId = null; uploadBusy = false;
    uploadRun = failed === 0 ? null : { done: ids.length, total: ids.length, failed };
  }

  async function uploadOne(project: { id: string; name: string }) {
    if (uploadBusy) return;
    uploadBusy = true; uploadingId = project.id; syncError = null;
    try { await projectStore.uploadToCloud(project.id); }
    catch { syncError = $t('library.sync.uploadFailed', { name: project.name || $t('library.untitled') }); }
    finally { uploadingId = null; uploadBusy = false; }
  }

  /** `file` is a library backup the welcome's Import a Plan was given. */
  function openRestore(file?: File) { showWelcome = false; restoreFile = file ?? null; restoreOpen = true; }
  function openPackage() { showWelcome = false; packageOpen = true; }
  async function afterRestore() {
    await refreshProjects();
    libraryError = null;
  }

  onMount(() => {
    // The first auth value is covered by the load below; a later change of user (sign-in or sign-out) reloads the list.
    let listedUid: string | null | undefined;
    const unsubscribeAuth = authState.subscribe((auth) => {
      const uid = auth.status === 'signedIn' ? auth.user.uid : null;
      if (uid === listedUid) return;
      const first = listedUid === undefined;
      listedUid = uid;
      syncUid = uid;
      promptDismissed = uid !== null && readPromptDismissed(uid);
      if (!first) void withLibraryError(refreshProjects);
    });
    void withLibraryError(async () => {
      await refreshProjects();
      const seen = localStorage.getItem('hasSeenWelcome');
      if (!seen && projects.length === 0) {
        showWelcome = true;
      }
    });
    return unsubscribeAuth;
  });

  async function createProject(create: () => unknown) {
    await withLibraryError(async () => {
      const project = await openProject(create, 'new', openingLifetime.signal);
      if (!project) return;
      showTemplateModal = false;
      goto(`${base}/editor?id=${encodeURIComponent(project.id)}`);
    });
  }

  function createFromTemplate(index: number) { return createProject(houseTemplates[index].create); }
  function newProject() { return createProject(() => createDefaultProject('Untitled Project')); }

  /** The last copy Duplicate made: named in a status line and outlined in the list. */
  let duplicatedId = $state<string | null>(null);
  let duplicateStatus = $state<HTMLElement>(), libraryAlert = $state<HTMLElement>();

  async function duplicateProject(id: string) {
    if (duplicating) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    duplicating = true; duplicatedId = null;
    let copyId: string | null = null;
    await withLibraryError(async () => {
      const dup = await projectStore.duplicate(id);
      if (!dup) throw new Error($t('library.gone'));
      copyId = dup.id;
    });
    // Refresh errors must not turn a completed copy into a retryable mutation.
    if (!libraryError) await withLibraryError(refreshProjects);
    duplicating = false; duplicatedId = copyId;
    await tick();
    if (document.activeElement === document.body && previous?.isConnected) previous.focus();
    // The copy is listed first, often above the card that was used: show the outcome there.
    (libraryError ? libraryAlert : duplicateStatus)?.scrollIntoView?.({ block: 'nearest' });
  }

  function openAction(type: 'rename' | 'delete', project: { id: string; name: string }) {
    actionDialog = { type, id: project.id, name: project.name || 'Untitled Project' };
    renameValue = project.name;
    actionError = null;
  }
  function closeAction() { if (!actionBusy) actionDialog = null; }
  async function submitAction() {
    const action = actionDialog, name = renameValue.trim();
    if (!action || actionBusy || (action.type === 'rename' && !name)) return;
    actionBusy = true; actionError = null;
    try {
      if (action.type === 'delete') await projectStore.delete(action.id);
      else {
        const project = await projectStore.load(action.id);
        if (!project) throw new Error($t('library.goneAction'));
        project.name = name;
        project.updatedAt = new Date();
        await projectStore.save(project);
      }
    } catch (error) {
      actionError = storageErrorMessage(error);
      actionBusy = false;
      return;
    }
    actionBusy = false;
    actionDialog = null;
    // Close only after the transaction commits, then refresh separately so a
    // failed list read cannot repeat a successful rename or delete.
    await withLibraryError(refreshProjects);
    await tick();
    if (action.type === 'delete' && document.activeElement === document.body) newProjectButton?.focus();
  }

  function formatDate(d: string, language: Locale) {
    const date = new Date(d);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return translate(language, 'library.justNow');
    if (diffMin < 60) return translate(language, 'library.minutes', { count: diffMin });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return translate(language, 'library.hours', { count: diffHr });
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return translate(language, 'library.days', { count: diffDay });
    return date.toLocaleDateString(language === 'pt' ? 'pt-BR' : 'en');
  }
</script>

{#if showWelcome}
  <WelcomeScreen onRestoreLibrary={openRestore} onImportPackage={openPackage} onDismiss={() => { showWelcome = false; void withLibraryError(refreshProjects); }} />
{/if}

{#if restoreOpen}<LibraryRestoreDialog file={restoreFile} onclose={() => restoreOpen = false} onrestored={afterRestore} />{/if}
{#if packageOpen}<ProjectPackageDialog onclose={() => packageOpen = false} onimported={afterRestore} />{/if}

<div class="min-h-screen bg-gray-50">
  <!-- Header -->
  <div class="bg-gradient-to-r from-slate-800 to-slate-700 shadow-sm">
    <div class="max-w-5xl mx-auto px-6 py-5 flex flex-wrap gap-4 items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{$t('library.title')}</h1>
        <p class="text-sm text-white/50 mt-0.5">{loading ? $t('library.loading') : $t(projects.length === 1 ? 'library.countOne' : 'library.countMany', { count: projects.length })}</p>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button
          onclick={() => showTemplateModal = true}
          class="px-4 py-2.5 bg-white/10 text-white rounded-lg hover:bg-white/20 font-medium text-sm transition-all flex items-center gap-2 border border-white/20"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          {$t('library.templates')}
        </button>
        <button
          bind:this={newProjectButton}
          onclick={newProject}
          class="px-5 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-semibold text-sm shadow-lg shadow-blue-500/25 transition-all hover:shadow-blue-500/40 flex items-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          {$t('library.new')}
        </button>
        <AccountButton variant="library" />
      </div>
    </div>
  </div>

  <div class="max-w-5xl mx-auto px-6 py-8">
    {#if duplicating}<p role="status" class="mb-4 text-sm text-gray-500">{$t('library.duplicating')}</p>
    {:else}
      {@const copy = projects.find(project => project.id === duplicatedId)}
      {#if copy}<p role="status" bind:this={duplicateStatus} class="mb-4 text-sm text-gray-600">{$t('library.duplicated', { name: copy.name || $t('library.untitled') })}</p>{/if}
    {/if}
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
      <p>{$t('library.local')}</p>
      <div class="flex flex-wrap gap-4">
        {#if !libraryError}<button class="font-semibold text-blue-600 underline" onclick={backupLibrary}>{$t('library.backup')}</button>{/if}
        <button class="font-semibold text-blue-600 underline" onclick={() => openRestore()}>{$t('library.restore')}</button>
        <button class="font-semibold text-blue-600 underline" onclick={openPackage}>{$t('library.package')}</button>
        <a class="font-semibold text-blue-600 underline" href={USER_GUIDE_URL} target="_blank" rel="noopener">{$t('help.userGuide')}</a>
      </div>
    </div>
    <LibraryStorageNote active={projects.length > 0 && !libraryError} />
    {#if libraryError}
      <div role="alert" bind:this={libraryAlert} class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p>{projectServiceMessage(libraryError, $locale)}</p>
        <div class="mt-3 flex gap-4">
          <button class="font-semibold underline" onclick={() => withLibraryError(refreshProjects)}>{$t('library.retry')}</button>
          <button class="font-semibold underline" onclick={backupLibrary}>{$t('library.backup')}</button>
        </div>
      </div>
    {/if}
    {#if signedIn && (uploadRun || (!promptDismissed && localProjects.length > 0))}
      <div class="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
        {#if uploadRun}
          {#if uploadRun.done < uploadRun.total}
            <p role="status">{$t('library.sync.progress', { done: uploadRun.done, total: uploadRun.total })}</p>
          {:else}
            <p role="alert">{$t('library.sync.someFailed', { failed: uploadRun.failed, total: uploadRun.total })}</p>
            <button class="font-semibold underline" onclick={dismissPrompt}>{$t('library.sync.dismiss')}</button>
          {/if}
        {:else}
          <p>{$t(localProjects.length === 1 ? 'library.sync.promptOne' : 'library.sync.promptMany', { count: localProjects.length })}</p>
          <div class="flex flex-wrap gap-4">
            <button class="rounded-lg bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700" onclick={uploadAll}>{$t('library.sync.uploadAll')}</button>
            <button class="font-semibold underline" onclick={dismissPrompt}>{$t('library.sync.notNow')}</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if syncError}
      <div role="alert" class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p>{syncError}</p>
      </div>
    {/if}
    {#if loading && projects.length === 0}
      <p role="status" class="py-12 text-center text-gray-500">{$t('library.loadingSaved')}</p>
    {:else if projects.length === 0 && !libraryError}
      <div class="text-center py-24">
        <div class="w-16 h-16 bg-gray-200 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="text-gray-400"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        </div>
        <p class="text-lg text-gray-400 font-medium">{$t('library.empty')}</p>
        <p class="text-sm text-gray-300 mt-1">{$t('library.emptyHelp')}</p>
        <div class="mt-6 flex items-center gap-3 justify-center">
          <button onclick={newProject} class="px-5 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-semibold text-sm">
            {$t('library.create')}
          </button>
          <button onclick={() => showTemplateModal = true} class="px-5 py-2.5 bg-white text-gray-700 rounded-lg hover:bg-gray-100 font-semibold text-sm border border-gray-200">
            {$t('library.fromTemplate')}
          </button>
        </div>
      </div>
    {:else}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {#each projects as project (project.id)}
          {@const status = signedIn ? (uploadingId === project.id ? 'uploading' : $syncStatus[project.id]) : undefined}
          <div class="group bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg hover:border-gray-300 transition-all duration-200 relative {project.id === duplicatedId ? 'ring-2 ring-blue-400' : ''}">
            <!-- Thumbnail -->
            <a href={`${base}/editor?id=${encodeURIComponent(project.id)}`} aria-label={$t('library.openName', { name: project.name || $t('library.untitled') })} class="block">
              <div class="aspect-[4/3] bg-gray-100 relative overflow-hidden">
                {#if Object.hasOwn(thumbnails, project.id) && thumbnails[project.id]}
                  <img src={thumbnails[project.id]} alt="" class="w-full h-full object-contain" />
                {:else}
                  <div class="w-full h-full flex items-center justify-center">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" class="text-gray-300"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                  </div>
                {/if}
              </div>
            </a>

            <!-- Info -->
            <div class="p-4">
              <a href={`${base}/editor?id=${encodeURIComponent(project.id)}`} class="block">
                <h3 class="font-semibold text-gray-800 text-sm truncate">{project.name || $t('library.untitled')}</h3>
              </a>
              <p class="text-xs text-gray-400 mt-1">{formatDate(project.updatedAt, $locale)}</p>
            </div>

            {#if status}
              <div class="absolute top-3 left-3 z-10 pointer-events-none"><SyncBadge {status} /></div>
            {/if}

            <ProjectActionsMenu name={project.name} disabled={duplicating}
              uploadable={signedIn && $syncStatus[project.id] === 'local'} uploadBusy={uploadBusy}
              onaction={(action) => {
                if (action === 'open') goto(`${base}/editor?id=${encodeURIComponent(project.id)}`);
                else if (action === 'duplicate') void duplicateProject(project.id);
                else if (action === 'upload') void uploadOne(project);
                else openAction(action, project);
              }} />
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if actionDialog}
    <dialog use:modalDialog aria-labelledby="library-action-title" aria-describedby="library-action-description"
      oncancel={(event) => { event.preventDefault(); closeAction(); }}
      onclose={(event) => reconcileNativeClose(event, actionBusy, closeAction)}
      class="m-auto w-[28rem] max-w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-5 text-gray-800 shadow-2xl backdrop:bg-black/50">
      <form onsubmit={(event) => { event.preventDefault(); void submitAction(); }}>
        <h2 id="library-action-title" class="text-lg font-semibold">{actionDialog.type === 'rename' ? $t('library.renameTitle') : $t('library.deleteTitle')}</h2>
        <p id="library-action-description" class="mt-2 break-words text-sm text-gray-500">
          {#if actionDialog.type === 'rename'}{$t('library.renameHelp', { name: actionDialog.name })}
          {:else}{$t('library.deleteHelp', { name: actionDialog.name })}{/if}
        </p>
        {#if actionDialog.type === 'rename'}
          <label for="library-project-name" class="mt-4 block text-sm font-medium">{$t('library.name')}</label>
          <input id="library-project-name" type="text" bind:value={renameValue} disabled={actionBusy} required
            class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-blue-500" />
        {/if}
        {#if actionError}<p role="alert" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">{projectServiceMessage(actionError, $locale)}</p>{/if}
        {#if actionBusy}<p role="status" class="mt-4 text-sm text-gray-500">{actionDialog.type === 'rename' ? $t('library.saving') : $t('library.deleting')}</p>{/if}
        <div class="mt-5 flex justify-end gap-3">
          <button type="button" onclick={closeAction} disabled={actionBusy} class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold disabled:opacity-40">{$t('library.cancel')}</button>
          <button type="submit" disabled={actionBusy || (actionDialog.type === 'rename' && !renameValue.trim())}
            class="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 {actionDialog.type === 'rename' ? 'bg-blue-600' : 'bg-red-600'}">
            {actionDialog.type === 'rename' ? $t('library.saveName') : $t('library.deleteTitle')}
          </button>
        </div>
      </form>
    </dialog>
  {/if}

  <!-- Template Modal -->
  {#if showTemplateModal}
    <dialog use:modalDialog class="modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" aria-label={$t('welcome.templatesTitle')} onclick={(e) => { if (e.target === e.currentTarget) showTemplateModal = false; }} oncancel={(e) => { e.preventDefault(); showTemplateModal = false; }}>
      <div class="bg-white rounded-2xl shadow-2xl p-8 max-w-xl w-full mx-4 max-h-[85vh] overflow-auto">
        <div class="flex items-center justify-between mb-2">
          <h2 class="text-2xl font-bold text-gray-800">{$t('welcome.templatesTitle')}</h2>
          <button aria-label={$t('library.closeTemplates')} onclick={() => showTemplateModal = false} class="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>
        <p class="text-sm text-gray-400 mb-6">{$t('welcome.templatesSubtitle')}</p>
        <div class="space-y-3">
          {#each houseTemplates as template, i}
            <button
              onclick={() => createFromTemplate(i)}
              class="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-blue-400 hover:bg-blue-50 transition-all text-left"
            >
              <span class="text-3xl">{template.icon}</span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-gray-800">{templateLabels[template.name] ? $t(templateLabels[template.name].name) : template.name}</div>
                <div class="text-xs text-gray-400">{templateLabels[template.name] ? $t(templateLabels[template.name].description) : template.description}</div>
              </div>
              <span class="text-xs font-medium text-blue-500 bg-blue-50 px-2 py-1 rounded-lg shrink-0">{template.area}</span>
            </button>
          {/each}
        </div>
      </div>
    </dialog>
  {/if}
</div>
