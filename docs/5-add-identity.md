# Add an Identity Provider

Once the application is running, you will need to add an identity provider to authenticate users. You will also need to configure an admin user.

> [!NOTE]
> Only one of the identity providers below needs to be configured.

## GitHub Authentication Provider

We'll create two GitHub apps: one for testing locally and another for production.

### Development App Setup

1. Navigate to GitHub OAuth Apps setup https://github.com/settings/developers
2. Create a `New OAuth App` https://github.com/settings/applications/new
3. Fill in the following details

   ```default
   Application name:  DEV Environment
   Homepage URL: http://localhost:3000
   Authorization callback URL: http://localhost:3000/api/auth/callback/github
   ```

### Production App Setup

1. Navigate to GitHub OAuth Apps setup https://github.com/settings/developers
2. Create a `New OAuth App` https://github.com/settings/applications/new
3. Fill in the following details

   ```default
   Application name:  Production
   Homepage URL: https://YOUR-APP-DOMAIN
   Authorization callback URL: https://YOUR-APP-DOMAIN/api/auth/callback/github
   ```

```bash
# GitHub OAuth app configuration
AUTH_GITHUB_ID=
AUTH_GITHUB_SECRET=
```

## Azure AD Authentication Provider

### Development App Setup

1. Navigate to [Azure AD Apps setup](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Create a [New Registration](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false)
3. Fill in the following details

   ```default
   Application name: DEV Environment
   Supported account types: Accounts in this organizational directory only
   Redirect URI Platform: Web
   Redirect URI: http://localhost:3000/api/auth/callback/azure-ad
   ```

### Production App Setup

1. Navigate to [Azure AD Apps setup](https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps)
2. Create a [New Registration](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false)
3. Fill in the following details

   ```default
   Application name: Production
   Supported account types: Accounts in this organizational directory only
   Redirect URI Platform: Web
   Redirect URI: https://YOUR-APP-DOMAIN/api/auth/callback/azure-ad
   ```

```bash
# Azure AD OAuth app configuration
AZURE_AD_CLIENT_ID=
AZURE_AD_CLIENT_SECRET=
AZURE_AD_TENANT_ID=
```

## Configure an admin user

The reporting pages in the application are only available to an admin user. Set the `ADMIN_EMAIL_ADDRESS` environment variable to the email address of the admin user.

[Next](/docs/6-chat-over-file.md)
