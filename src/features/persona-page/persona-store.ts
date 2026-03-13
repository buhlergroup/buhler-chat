import { proxy, useSnapshot } from "valtio";
import { RevalidateCache } from "../common/navigation-helpers";
import {
  DocumentMetadata,
  PERSONA_ATTRIBUTE,
  PersonaModel,
} from "./persona-services/models";
import {
  CreatePersona,
  UpsertPersona,
} from "./persona-services/persona-service";
import { UpdateOrAddPersonaCIDocuments } from "./persona-services/persona-ci-documents-service";

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

export const AddOrUpdatePersona = async (previous: any, formData: FormData) => {
  const sharePointFiles = HandleSharePointFiles(formData);
  const ciSharePointFiles = HandleCISharePointFiles(formData);
  const persona = FormDataToPersonaModel(formData);

  if (personaStore.persona.extensionIds) {
    persona.extensionIds = personaStore.persona.extensionIds.map((e) => e);
  }

  // Handle Code Interpreter documents
  const currentCIDocuments = persona.codeInterpreterDocumentIds || [];
  const ciDocsResponse = await UpdateOrAddPersonaCIDocuments(
    ciSharePointFiles,
    currentCIDocuments
  );

  if (ciDocsResponse.status === "OK") {
    persona.codeInterpreterDocumentIds = ciDocsResponse.response;
  } else {
    return ciDocsResponse;
  }

  const response =
    persona.id && persona.id !== ""
      ? await UpsertPersona(persona, sharePointFiles)
      : await CreatePersona(persona, sharePointFiles);

  if (response.status === "OK") {
    personaStore.updateOpened(false);
    RevalidateCache({
      page: "persona",
    });
    RevalidateCache({
      page: "agent",
    });
  }

  return response;
};

const HandleSharePointFiles = (formData: FormData): DocumentMetadata[] => {
  const filesObjStrings = formData.getAll(
    "selectedSharePointDocumentIds"
  ) as string[];

  if (!filesObjStrings || filesObjStrings[0].length === 0) return [];

  const fileObj = JSON.parse(filesObjStrings[0]) as DocumentMetadata[];
  return Array.isArray(fileObj) ? fileObj : [];
};

const HandleCISharePointFiles = (formData: FormData): DocumentMetadata[] => {
  const filesObjStrings = formData.getAll(
    "selectedCIDocumentIds"
  ) as string[];

  if (!filesObjStrings || filesObjStrings.length === 0 || filesObjStrings[0].length === 0) return [];

  const fileObj = JSON.parse(filesObjStrings[0]) as DocumentMetadata[];
  return Array.isArray(fileObj) ? fileObj : [];
};

const FormDataToPersonaModel = (formData: FormData): PersonaModel => {
  const ids = formData.getAll("personaDocumentIds") as string[];
  const fileObj = JSON.parse(ids[0]) as string[];
  const personaDocumentIds =  Array.isArray(fileObj) ? fileObj : [];

  const ciIds = formData.getAll("ciDocumentIds") as string[];
  const ciFileObj = ciIds.length > 0 && ciIds[0].length > 0 
    ? JSON.parse(ciIds[0]) as string[] 
    : [];
  const codeInterpreterDocumentIds = Array.isArray(ciFileObj) ? ciFileObj : [];

  const selectedModelRaw = formData.get("selectedModel") as string | null;
  const selectedModel = selectedModelRaw || undefined;
  
  const subAgentIdsRaw = formData.get("subAgentIds") as string;
  const subAgentIds = subAgentIdsRaw
    ? JSON.parse(subAgentIdsRaw) as string[]
    : [];

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
    personaDocumentIds: personaDocumentIds,
    codeInterpreterDocumentIds: codeInterpreterDocumentIds,
    selectedModel: selectedModel,
    subAgentIds: subAgentIds,
  };
};
