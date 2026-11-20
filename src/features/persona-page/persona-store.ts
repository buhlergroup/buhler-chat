import { proxy, useSnapshot } from "valtio";
import { RevalidateCache } from "../common/navigation-helpers";
import { PERSONA_ATTRIBUTE, PersonaModel } from "./persona-services/models";
import {
  CreatePersona,
  UpsertPersona,
} from "./persona-services/persona-service";

class PersonaState {
  private defaultModel: PersonaModel = {
    id: "",
    name: "",
    description: "",
    personaMessage: "",
    createdAt: new Date(),
    isPublished: false,
    type: "PERSONA",
    userId: "",
    extensionIds: [],
  };

  public isOpened: boolean = false;
  public errors: string[] = [];
  public persona: PersonaModel = { ...this.defaultModel };

  public addExtension(id: string): void {
    if (!this.persona.extensionIds) {
      this.persona.extensionIds = [];
    }
    this.persona.extensionIds.push(id);
  }

  public removeExtension(id: string): void {
    if (!this.persona.extensionIds) {
      return;
    }
    this.persona.extensionIds = this.persona.extensionIds.filter(
      (e) => e !== id
    );
  }

  public updateOpened(value: boolean) {
    this.isOpened = value;
  }

  public updatePersona(persona: PersonaModel) {
    this.persona = {
      ...persona,
    };
    this.isOpened = true;
  }

  public newPersona() {
    this.persona = {
      ...this.defaultModel,
    };
    this.isOpened = true;
  }

  public newPersonaAndOpen(persona: {
    name: string;
    description: string;
    personaMessage: string;
    extensionIds: string[];
  }) {
    this.persona = {
      ...this.defaultModel,
      name: persona.name,
      description: persona.description,
      personaMessage: persona.personaMessage,
      extensionIds: persona.extensionIds,
    };
    this.isOpened = true;
  }

  public updateErrors(errors: string[]) {
    this.errors = errors;
  }
}

export const personaStore = proxy(new PersonaState());

export const usePersonaState = () => {
  return useSnapshot(personaStore, { sync: true });
};

/**
 * Saves the agent form. Files are not part of the form: the Files section
 * saves them immediately (agent-file-service). After the FIRST save of a new
 * agent the editor stays open on the saved agent, so files can be added
 * right away; a save of an existing agent closes the editor.
 */
export const AddOrUpdatePersona = async (previous: any, formData: FormData) => {
  const persona = FormDataToPersonaModel(formData);

  if (personaStore.persona.extensionIds) {
    persona.extensionIds = personaStore.persona.extensionIds.map((e) => e);
  }

  const isNew = !persona.id;
  const response = isNew
    ? await CreatePersona(persona)
    : await UpsertPersona(persona);

  if (response.status === "OK") {
    if (isNew) {
      personaStore.updatePersona(response.response);
    } else {
      personaStore.updateOpened(false);
    }
    RevalidateCache({
      page: "persona",
    });
    RevalidateCache({
      page: "agent",
    });
  }

  return response;
};

const FormDataToPersonaModel = (formData: FormData): PersonaModel => {
  const selectedModelRaw = formData.get("selectedModel") as string | null;
  const selectedModel = selectedModelRaw || undefined;
  
  const subAgentIdsRaw = formData.get("subAgentIds") as string;
  const subAgentIds = subAgentIdsRaw
    ? JSON.parse(subAgentIdsRaw) as string[]
    : [];

  const defaultToolsRaw = formData.get("defaultTools") as string;
  const defaultTools = defaultToolsRaw
    ? JSON.parse(defaultToolsRaw)
    : undefined;

  return {
    id: formData.get("id") as string,
    name: formData.get("name") as string,
    description: formData.get("description") as string,
    personaMessage: formData.get("personaMessage") as string,
    isPublished: formData.get("isPublished") === "on" ? true : false,
    userId: "", // the user id is set on the server once the user is authenticated
    extensionIds: formData.getAll("extensionIds") as string[],
    createdAt: new Date(),
    type: PERSONA_ATTRIBUTE,
    accessGroup: {
      id: formData.get("accessGroupId") as string,
      source: "SHAREPOINT",
    },
    selectedModel: selectedModel,
    subAgentIds: subAgentIds,
    defaultTools: defaultTools,
  };
};
