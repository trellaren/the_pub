import { isDesktopPlatform } from '@shared/platform.js'
import { useAppStore } from '@renderer/stores/appStore.js'

/** True until app state says otherwise, so a desktop window never flashes the mobile variant while it loads. */
export function useIsDesktop(): boolean {
  return useAppStore((store) => isDesktopPlatform(store.state?.platform))
}
