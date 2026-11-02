<script lang="ts">
  import { t } from '$lib/i18n';
  import { onDestroy } from 'svelte';
  import { modalDialog, reconcileNativeClose } from '$lib/utils/modalDialog';
  import { projectStore } from '$lib/services/projectStore';
  import { shareUrl } from '$lib/services/cloudStore';
  import { currentUser } from '$lib/stores/auth';
  import { checkEditorEmail } from '$lib/utils/shareEditors';

  let { id, name, onclose }: { id: string; name: string; onclose: () => void } = $props();
  const cloudMeta = projectStore.cloudMeta;
  const meta = $derived($cloudMeta[id]);
  const myEmail = (currentUser()?.email ?? '').toLowerCase();
  const isOwner = $derived(!!meta?.isOwner);
  const editors = $derived(meta?.editorEmails ?? []);
  const token = $derived(meta?.shareToken ?? null);
  const link = $derived(token ? shareUrl(token, location.origin) : '');

  let email = $state('');
  let editorBusy = $state(false);
  let editorError = $state<string | null>(null);
  let linkBusy = $state(false);
  let linkError = $state<string | null>(null);
  let copied = $state(false);
  let linkInput = $state<HTMLInputElement>();
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  onDestroy(() => { alive = false; clearTimeout(copyTimer); });
  const busy = $derived(editorBusy || linkBusy);

  const message = (e: unknown) => e instanceof Error && e.message ? e.message : $t('share.failed');

  async function changeEditors(next: string[]) {
    editorBusy = true; editorError = null;
    try { await projectStore.setEditors(id, next); }
    catch (e) { if (alive) editorError = message(e); }
    finally { if (alive) editorBusy = false; }
  }
  async function add() {
    if (editorBusy) return;
    const checked = checkEditorEmail(email, editors);
    if ('problem' in checked) { editorError = $t(`share.email.${checked.problem}`); return; }
    await changeEditors([...editors, checked.email]);
    if (alive && !editorError) email = '';
  }
  const remove = (target: string) => changeEditors(editors.filter(e => e !== target));

  async function toggleLink() {
    if (linkBusy) return;
    linkBusy = true; linkError = null; copied = false;
    try {
      if (token) await projectStore.disableSharing(id);
      else await projectStore.enableSharing(id);
    } catch (e) { if (alive) linkError = message(e); }
    finally { if (alive) linkBusy = false; }
  }
  async function copy() {
    linkError = null;
    try {
      await navigator.clipboard.writeText(link);
      copied = true; clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; }, 2000);
    } catch {
      linkInput?.focus(); linkInput?.select();
    }
  }
</script>

<dialog use:modalDialog aria-labelledby="share-title"
  oncancel={(event) => { event.preventDefault(); onclose(); }}
  onclose={(event) => reconcileNativeClose(event, false, onclose)}
  class="m-auto w-[30rem] max-w-[calc(100vw-2rem)] max-h-[85vh] overflow-y-auto rounded-2xl bg-white p-5 text-gray-800 shadow-2xl backdrop:bg-black/50">
  <div class="flex items-start justify-between gap-4">
    <h2 id="share-title" class="min-w-0 break-words text-lg font-semibold">{$t('share.title', { name: name || $t('library.untitled') })}</h2>
    <button type="button" aria-label={$t('share.close')} onclick={onclose} class="rounded px-2 py-1 text-gray-500 hover:bg-gray-100">✕</button>
  </div>

  {#if !meta}
    <p role="alert" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">{$t('share.unavailable')}</p>
  {:else}
    <section class="mt-4" aria-labelledby="share-editors-title">
      <h3 id="share-editors-title" class="text-sm font-semibold">{$t('share.editors')}</h3>
      <ul class="mt-2 divide-y divide-gray-100 rounded-lg border border-gray-200">
        {#each editors as editor (editor)}
          {@const owner = isOwner ? editor === myEmail : false}
          <li class="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <span class="min-w-0 break-all">{editor}{#if owner} <span class="text-gray-500">{$t('share.owner')}</span>{/if}</span>
            {#if isOwner && !owner}
              <button type="button" onclick={() => remove(editor)} disabled={editorBusy}
                aria-label={$t('share.remove', { email: editor })}
                class="shrink-0 rounded px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40">{$t('share.removeShort')}</button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if isOwner}
        <form class="mt-3 flex gap-2" onsubmit={(event) => { event.preventDefault(); void add(); }}>
          <label for="share-email" class="sr-only">{$t('share.emailLabel')}</label>
          <input id="share-email" type="email" bind:value={email} disabled={editorBusy} placeholder={$t('share.emailPlaceholder')}
            autocomplete="off" aria-invalid={!!editorError} oninput={() => { editorError = null; }}
            class="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-blue-500" />
          <button type="submit" disabled={editorBusy || !email.trim()}
            class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">{editorBusy ? $t('share.saving') : $t('share.add')}</button>
        </form>
      {:else}
        <p class="mt-2 text-xs text-gray-500">{$t('share.ownerOnly')}</p>
      {/if}
      {#if editorError}<p role="alert" class="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-900">{editorError}</p>{/if}
    </section>

    <section class="mt-5" aria-labelledby="share-link-title">
      <div class="flex items-center justify-between gap-3">
        <h3 id="share-link-title" class="text-sm font-semibold">{$t('share.link')}</h3>
        <button type="button" role="switch" aria-checked={!!token} aria-labelledby="share-link-title" onclick={toggleLink} disabled={linkBusy}
          class="relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-40 {token ? 'bg-blue-600' : 'bg-gray-300'}">
          <span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform {token ? 'translate-x-5' : ''}"></span>
        </button>
      </div>
      <p id="share-link-help" class="mt-1 text-xs text-gray-500">{$t('share.linkHelp')}</p>
      {#if linkBusy}<p role="status" class="mt-2 text-sm text-gray-500">{token ? $t('share.disabling') : $t('share.enabling')}</p>{/if}
      {#if token && !linkBusy}
        <div class="mt-3 flex gap-2">
          <label for="share-url" class="sr-only">{$t('share.urlLabel')}</label>
          <input id="share-url" bind:this={linkInput} readonly value={link} onfocus={(e) => e.currentTarget.select()}
            class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm outline-blue-500" />
          <button type="button" onclick={copy}
            class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold hover:bg-gray-50">{copied ? $t('share.copied') : $t('share.copy')}</button>
        </div>
        <p role="status" class="sr-only">{copied ? $t('share.copied') : ''}</p>
      {/if}
      {#if linkError}<p role="alert" class="mt-2 rounded-lg bg-red-50 p-3 text-sm text-red-900">{linkError}</p>{/if}
    </section>
  {/if}

  <div class="mt-5 flex justify-end">
    <button type="button" onclick={onclose} class="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold hover:bg-gray-50">{$t('share.done')}</button>
  </div>
</dialog>
