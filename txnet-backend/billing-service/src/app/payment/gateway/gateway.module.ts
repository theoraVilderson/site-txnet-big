import { Module } from '@nestjs/common';
import {
  CredentialEnvGuard,
  CredentialVaultService,
  KekService,
  VAULT_DB,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { GatewayMerchant } from './gateway-merchant';
import { GrantedVaultAccess } from './granted-vault-access';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { tenantBoundVaultDb } from './tenant-bound-vault-db';
import { WebhookSecretSource } from './webhook-secret';

/**
 * Payment gateways (F-092-f): the driver registry and the merchant id each call
 * needs, read from the tenant's vault.
 *
 * The vault is loaded here, not in a module of its own, because the gateway is
 * the only thing in this service that reads a credential. `CredentialEnvGuard`
 * comes with it for the reason `auth-service`'s `VaultModule` gives: a service
 * that loads the vault refuses to boot holding a tenant credential in its
 * environment (F-1216).
 *
 * No route calls this yet — F-092-o quotes a fee, F-092-i starts a payment.
 */
@Module({
  providers: [
    KekService,
    CredentialVaultService,
    CredentialEnvGuard,
    { provide: VAULT_DB, inject: [PrismaService], useFactory: tenantBoundVaultDb },
    PaymentProviderRegistry,
    GrantedVaultAccess,
    GatewayMerchant,
    WebhookSecretSource,
  ],
  exports: [PaymentProviderRegistry, GatewayMerchant, GrantedVaultAccess, WebhookSecretSource],
})
export class GatewayModule {}
