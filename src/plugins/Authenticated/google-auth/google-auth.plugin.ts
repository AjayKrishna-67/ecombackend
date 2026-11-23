// src/plugins/google-auth/google-auth.plugin.ts
import { VendurePlugin, PluginCommonModule, VendureConfig } from '@vendure/core';
import { GoogleAuthenticationStrategy } from './google-authentication-strategy';

@VendurePlugin({
  imports: [PluginCommonModule],
})
export class GoogleAuthPlugin {
  static init(clientId: string) {
    return {
      plugin: GoogleAuthPlugin,
      configuration: (config: VendureConfig): VendureConfig => {
        config.authOptions.shopAuthenticationStrategy = [
          new GoogleAuthenticationStrategy(clientId),
        ];
        return config;
      },
    };
  }
}
