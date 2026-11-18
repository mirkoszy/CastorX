import { ProxiedSignInPage } from '@backstage/core-components';
import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';

// IAP has already authenticated the user before a request reaches Backstage,
// so this page exchanges the IAP identity for a session without showing a prompt.
export const signInModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    SignInPageBlueprint.make({
      params: {
        loader: async () => props =>
          <ProxiedSignInPage {...props} provider="gcpIap" />,
      },
    }),
  ],
});
