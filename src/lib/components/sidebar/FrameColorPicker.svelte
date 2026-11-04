<script lang="ts">
  import { t } from '$lib/i18n';
  import { FRAME_COLOR_PRESETS } from '$lib/utils/doorStyle';

  /** `value` is the colour in effect (saved or default); `saved` says whether one is saved,
   * which shows the Default link. `onchange(undefined)` clears the saved colour. */
  let { value, saved, onchange }: { value: string; saved: boolean; onchange: (color: string | undefined) => void } = $props();
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
</script>

<div role="group" aria-label={$t('openingProperties.frameColor')}>
  <span class="text-xs text-gray-500 block mb-2">{$t('openingProperties.frameColor')}</span>
  <div class="grid grid-cols-7 gap-1.5 mb-2">
    {#each FRAME_COLOR_PRESETS as { key, color }}
      <button
        class="w-6 h-6 rounded border-2 hover:border-gray-300 transition-colors {same(value, color) ? 'border-blue-500 ring-1 ring-blue-200' : 'border-gray-200'}"
        style="background-color: {color}"
        title={$t(`doorFrameColor.${key}`)}
        aria-label={$t(`doorFrameColor.${key}`)}
        aria-pressed={same(value, color)}
        onclick={() => onchange(color)}
      ></button>
    {/each}
  </div>
  <div class="flex items-center gap-2">
    <span class="text-xs text-gray-500">{$t('furnitureProperties.custom')}</span>
    <input
      type="color" aria-label={$t('furnitureProperties.customColor')}
      {value}
      oninput={(e) => onchange((e.target as HTMLInputElement).value)}
      class="w-8 h-6 rounded border border-gray-200 cursor-pointer"
    />
    {#if saved}
      <button
        class="ml-auto text-xs text-gray-500 hover:text-gray-700 underline"
        onclick={() => onchange(undefined)}
      >{$t('openingProperties.defaultFrameColor')}</button>
    {/if}
  </div>
</div>
