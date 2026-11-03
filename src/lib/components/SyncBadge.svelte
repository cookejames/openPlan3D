<script lang="ts">
  import { t, type TranslationKey } from '$lib/i18n';
  import type { SyncStatus } from '$lib/services/syncStore';

  /** 'uploading' is a page-level state while this browser sends a local project to the cloud. */
  let { status }: { status: SyncStatus | 'uploading' } = $props();

  const labels: Record<SyncStatus | 'uploading', TranslationKey> = {
    synced: 'library.sync.synced',
    syncing: 'library.sync.syncing',
    local: 'library.sync.local',
    cloud: 'library.sync.cloud',
    offline: 'library.sync.offline',
    conflict: 'library.sync.conflict',
    error: 'library.sync.error',
    uploading: 'library.sync.uploading',
  };
  const tones: Record<SyncStatus | 'uploading', string> = {
    synced: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    syncing: 'bg-blue-50 text-blue-700 border-blue-200',
    uploading: 'bg-blue-50 text-blue-700 border-blue-200',
    local: 'bg-white text-gray-600 border-gray-300',
    cloud: 'bg-sky-50 text-sky-700 border-sky-200',
    offline: 'bg-amber-50 text-amber-800 border-amber-200',
    conflict: 'bg-orange-50 text-orange-800 border-orange-200',
    error: 'bg-red-50 text-red-700 border-red-200',
  };
</script>

<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 shadow-sm {tones[status]}">{$t(labels[status])}</span>
