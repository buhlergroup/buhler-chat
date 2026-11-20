"use server";
import "server-only";
import { getGraphClient } from "../../common/services/microsoft-graph-client";
import { getCurrentUser } from "@/features/auth-page/helpers";
import { odataEq } from "@/features/common/odata-filter";
import { AccessGroup } from "@/features/persona-page/persona-services/models";
import { ServerActionResponse } from "@/features/common/server-action-response";
import { SESSION_EXPIRED_ERROR_CODE } from "@/features/common/error-codes";

const SESSION_EXPIRED_MESSAGE =
  "Your session expired. We'll sign you out so you can sign in again.";

const sessionExpiredResponse = <T>(): ServerActionResponse<T> => ({
  status: "UNAUTHORIZED",
  errors: [
    {
      code: SESSION_EXPIRED_ERROR_CODE,
      message: SESSION_EXPIRED_MESSAGE,
    },
  ],
});

const isSessionExpired = (error: unknown): boolean => {
  if (error instanceof Error) {
    return (
      error.message.includes("Access token is undefined or empty") ||
      error.message === "User not found"
    );
  }

  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error as { statusCode?: number }).statusCode === 401
  ) {
    return true;
  }

  return false;
};

export async function UserAccessGroups(): Promise<
  ServerActionResponse<AccessGroup[]>
> {
  try {
    const user = await getCurrentUser();

    if (user.isLocalDevUser) {
      return {
        status: "OK",
        response: [],
      };
    }

    if (!user.token) {
      return sessionExpiredResponse<AccessGroup[]>();
    }

    const client = getGraphClient(user.token);

    const response = await client
      .api("/me/memberOf/$/microsoft.graph.group")
      .filter("groupTypes/any(c:c eq 'Unified')")
      .select("id,displayName,description")
      .get();

    const accessGroups = response.value.map((group: any) => ({
      id: group.id,
      name: group.displayName,
      description: group.description,
    })) as AccessGroup[];

    return {
      status: "OK",
      response: accessGroups,
    };
  } catch (error: unknown) {
    if (isSessionExpired(error)) {
      return sessionExpiredResponse<AccessGroup[]>();
    }

    if (error instanceof Error) {
      return {
        status: "ERROR",
        errors: [
          {
            message: `Failed to fetch access groups: ${error.message} Try logging in again.`,
          },
        ],
      };
    }

    return {
      status: "ERROR",
      errors: [
        {
          message: "Failed to fetch access groups: Unknown error",
        },
      ],
    };
  }
}

export async function AccessGroupById(
  accessGroupId: string
): Promise<ServerActionResponse<AccessGroup>> {
  try {
    const user = await getCurrentUser();

    if (user.isLocalDevUser) {
      return {
        status: "OK",
        response: {
          id: accessGroupId,
          name: "Local development group",
          description: "Placeholder group for local development mode.",
        },
      };
    }

    if (!user.token) {
      return sessionExpiredResponse<AccessGroup>();
    }

    const client = getGraphClient(user.token);

    const response = await client
      .api(`/me/memberOf/`)
      .filter(odataEq("id", accessGroupId))
      .select("id,displayName,description")
      .get();

    const group = response.value[0];

    const accessGroup = {
      id: group.id,
      name: group.displayName,
      description: group.description,
    } as AccessGroup;

    return {
      status: "OK",
      response: accessGroup,
    };
  } catch (error) {
    if (isSessionExpired(error)) {
      return sessionExpiredResponse<AccessGroup>();
    }

    return {
      status: "ERROR",
      errors: [
        {
          message: `Failed to fetch access group by ID: ${error} Try logging in again.`,
        },
      ],
    };
  }
}
