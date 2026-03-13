# Run Locally

Clone this repository locally or fork to your GitHub account. Run all of the steps below from the `src` directory.

## Prerequisites

- **History Database**: You must have a Cosmos DB instance configured to store chat history. Set the connection string via the `AZURE_COSMOSDB_URI` environment variable.

- **Identity Provider**: For local development, you can use a username / password. If you prefer an Identity Provider, follow the [instructions](./5-add-identity.md) to add one.

## Steps

1. Change directory to the `src` folder
2. Rename the file `.env.example` to `.env.local` and populate the environment variables
3. Install npm packages by running `npm install`
4. Start the app by running `npm run dev`
5. Access the app on [http://localhost:3000](http://localhost:3000)

You should now be prompted to login with your chosen OAuth provider.

> [!NOTE]
> If using Basic Auth (DEV ONLY) any username you enter will create a new user id (hash of username@localhost). You can use this to simulate multiple users. Once successfully logged in, you can start creating new conversations.

[Next](/docs/5-add-identity.md)
