<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t } from '$lib/i18n';
  import { authState, signIn, signOut } from '$lib/stores/auth';

  /** `library` sits on the dark library header; `toolbar` on the editor's dark top bar. */
  let { variant = 'library' }: { variant?: 'library' | 'toolbar' } = $props();
  const id = $props.id();

  const size = $derived(variant === 'toolbar'
    ? 'px-2 py-1 text-sm'
    : 'px-4 py-2.5 text-sm');
  const pill = $derived(variant === 'toolbar'
    ? 'text-white/90 hover:text-white hover:bg-white/10 rounded transition-colors'
    : 'bg-white/10 text-white rounded-lg hover:bg-white/20 font-medium border border-white/20 transition-all');

  let busy = $state(false);
  let error = $state<string | null>(null);
  let menuOpen = $state(false);
  let avatarFailed = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  function showError(message: string) {
    error = message;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { error = null; }, 6000);
  }

  async function onSignIn() {
    if (busy) return;
    busy = true;
    try {
      await signIn();
    } catch (e) {
      console.error('Sign-in failed', e);
      showError($t('account.signInError'));
    } finally {
      busy = false;
    }
  }

  async function onSignOut() {
    if (busy) return;
    busy = true;
    try {
      await signOut();
      menuOpen = false;
    } catch (e) {
      console.error('Sign-out failed', e);
      showError($t('account.signOutError'));
    } finally {
      busy = false;
    }
  }

  function closeMenu(restoreFocus = false) {
    menuOpen = false;
    if (restoreFocus) trigger?.focus({ preventScroll: true });
  }

  function outside(event: Event) {
    const target = event.target as Node;
    if (menuOpen && !panel?.contains(target) && !trigger?.contains(target)) closeMenu();
  }

  function onEscape(event: KeyboardEvent) {
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
    }
  }

  onDestroy(() => clearTimeout(errorTimer));
</script>

<svelte:window onpointerdown={outside} onfocusin={outside} onkeydown={onEscape} />

{#if $authState.status === 'loading'}
  <!-- Same footprint as the signed-in control so the header does not shift when auth resolves. -->
  <span aria-hidden="true" class="inline-block shrink-0 {variant === 'toolbar' ? 'h-7 w-7' : 'h-[42px] w-[42px]'}"></span>
{:else if $authState.status === 'signedOut'}
  <div class="relative shrink-0 flex items-center gap-2">
    <button
      type="button"
      onclick={onSignIn}
      disabled={busy}
      aria-busy={busy}
      class="{size} {pill} flex items-center gap-2 disabled:opacity-50 disabled:cursor-wait"
    >
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      {busy ? $t('account.signingIn') : $t('account.signIn')}
    </button>
    {#if error}
      <span role="alert" class="text-xs {variant === 'toolbar' ? 'text-red-200' : 'text-red-300'} max-w-48">{error}</span>
    {/if}
  </div>
{:else if $authState.status === 'signedIn'}
  {@const user = $authState.user}
  {@const initial = (user.email.charAt(0) || '?').toUpperCase()}
  <div class="relative shrink-0">
    <button
      bind:this={trigger}
      type="button"
      onclick={() => menuOpen ? closeMenu(true) : (menuOpen = true)}
      aria-label={$t('account.menu')}
      aria-haspopup="true"
      aria-expanded={menuOpen}
      aria-controls={menuOpen ? id : undefined}
      class="{variant === 'toolbar' ? 'p-0.5' : 'p-1'} {pill} flex items-center justify-center"
    >
      {#if user.photoURL && !avatarFailed}
        <img
          src={user.photoURL}
          alt=""
          referrerpolicy="no-referrer"
          onerror={() => { avatarFailed = true; }}
          class="{variant === 'toolbar' ? 'w-6 h-6' : 'w-8 h-8'} rounded-full object-cover"
        />
      {:else}
        <span aria-hidden="true" class="{variant === 'toolbar' ? 'w-6 h-6 text-xs' : 'w-8 h-8 text-sm'} rounded-full bg-blue-500 text-white font-semibold flex items-center justify-center">{initial}</span>
      {/if}
    </button>
    {#if menuOpen}
      <div
        bind:this={panel}
        {id}
        class="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border border-gray-200 py-1 w-64 max-w-[calc(100vw-2rem)] z-50"
      >
        <div class="px-3 py-2 border-b border-gray-100">
          <p class="text-[10px] font-bold uppercase tracking-wider text-gray-400">{$t('account.signedInAs')}</p>
          <p class="text-sm text-gray-800 truncate" title={user.email}>{user.email}</p>
        </div>
        {#if error}
          <p role="alert" class="px-3 pt-2 text-xs text-red-700">{error}</p>
        {/if}
        <button
          type="button"
          onclick={onSignOut}
          disabled={busy}
          class="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 text-left disabled:opacity-50"
        >
          {busy ? $t('account.signingOut') : $t('account.signOut')}
        </button>
      </div>
    {/if}
  </div>
{/if}
