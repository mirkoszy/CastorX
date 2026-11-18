#!/bin/sh
set -e

# /src is the read-only Backstage checkout. Dependencies and build output stay in the volume.
echo "Copying Backstage source into the workspace volume..."
tar -C /src --exclude=./.git --exclude=node_modules -cf - . | tar -C /workspace -xf -
cp /config/app-config.local.yaml /workspace/app-config.local.yaml

# The source is re-copied on every start, so the sign-in module is added to a clean App.tsx each time.
echo "Adding the GitHub sign-in page..."
cp -R /overlay/. /workspace/
app=packages/app/src/App.tsx
sed -i -e "/^import { appModuleScaffolder } /a import { appModuleSignIn } from './modules/appModuleSignIn';" \
       -e "s/^    appModuleScaffolder,$/&\n    appModuleSignIn,/" "$app"
if [ "$(grep -c appModuleSignIn "$app")" -ne 2 ]; then
  echo "Could not add the sign-in module: $app has changed." >&2
  exit 1
fi

yarn_cmd="node .yarn/releases/$(ls .yarn/releases | head -1)"

echo "Installing dependencies. The first run takes a long time..."
$yarn_cmd install --immutable

echo "Starting Backstage..."
exec $yarn_cmd start
