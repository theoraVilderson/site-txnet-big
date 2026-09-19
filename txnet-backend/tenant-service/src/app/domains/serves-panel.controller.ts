import { Controller, Get, HttpCode, HttpStatus, Req } from '@nestjs/common';
import {
  doorServesPanel,
  PUBLIC_SURFACE,
  publicPath,
  PublicRoute,
  TenantCapability,
  type HostSurface,
} from '@txnet-backend/shared-core';

/**
 * `GET /api/public/tenant/serves-panel` — may the host that asked serve the
 * panel? (F-066-x, moved here from `GET /api/auth/door` by F-018-ak.)
 *
 * `{ serves: boolean }` and nothing else: no purpose, no tenant. The panel
 * needs a yes or a no, and a stranger learns no more from this than from the
 * page the panel then does or does not render. A host with no surface is the
 * neutral 404, which the panel reads as "nothing to mirror".
 *
 * `'any'` doors, because its answer is the door's state: it has to answer on
 * exactly the doors the others refuse. `system`, because whether a door is open
 * is not something a terminated reseller should be refused an answer to.
 */
@Controller(publicPath('tenant', 'serves-panel'))
export class ServesPanelController {
  @Get()
  @HttpCode(HttpStatus.OK)
  @PublicRoute({ doors: 'any' })
  @TenantCapability('system')
  servesPanel(@Req() req: Record<symbol, HostSurface>): { serves: boolean } {
    return { serves: doorServesPanel(req[PUBLIC_SURFACE]) };
  }
}
