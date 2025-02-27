import { commands, env, ExtensionContext, QuickPickItem, Range, Uri, ViewColumn, window, workspace } from 'vscode';

import { appendFileSync, existsSync, mkdirSync, PathLike, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import * as jsonc from 'jsonc-parser';
import * as path from "path";
import { ConfigurationManager } from '../helper/ConfigurationManager';
import { LoggingService } from '../helper/LoggingService';
import { createDirectoryPath, getSubFolders, getWorkspaceRootPath, rtrim, showInformationProgress } from '../helper/utilities';
import { ExportTaskStore } from '../stores/ExportTaskStore';
import { getAvailableObjectTypes } from '../wizards/CreateObjectWizard';
import { dbFolderDef, restFolderDef, rewriteInstall, writeCreateWorkspaceAdminScript, writeCreateWorkspaceScript, writeUserCreationScript } from '../wizards/InitializeProjectWizard';
import { MultiStepInput } from '../wizards/InputFlowAction';
import { getDBUserFromPath, getProjectInfos, IProjectInfos } from './AbstractBashTaskProvider';

export async function addAPEXApp(context: ExtensionContext, folder:string) {
  interface State {
    title: string;
    step: number;
    totalSteps: number;

    appID: string;
    workSpace: QuickPickItem;
  }

  async function collectInputs() {
    const state = {} as Partial<State>;

    await MultiStepInput.run(input => pickWorkspaces(input, state));
    return state as State;
  }




  async function pickWorkspaces(input: MultiStepInput, state: Partial<State>) {
    state.workSpace = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 2,
      placeholder: 'Pick a workspace',
      items: objectTypes,
      activeItem: objectTypes[0],
      shouldResume: shouldResume,
      canSelectMany:false
    });

    return (input: MultiStepInput) => inputObjectName(input, state);
  }

  async function inputObjectName(input: MultiStepInput, state: Partial<State>) {
    state.appID = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 2,
      value: state.appID || '',
      prompt: 'Enter Application ID',
      validate: validateValueIsRequiered,
      shouldResume: shouldResume
    });

  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      // noop
    });
  }

  async function validateValueIsRequiered(name: string) {
    // eslint-disable-next-line eqeqeq
    return (name == undefined || name.length === 0) ? 'Value is required' : undefined;
  }


  const title = 'Add APEX Application';
  const objectTypes = await getAvailableWorkSpaces(folder);
  if (objectTypes.length > 0) {
    const state = await collectInputs();

    if (state.appID) {
      if (folder === "apex") {
        // when adding an application a static folder is created too
        addApplication(state.appID, state.workSpace.description!);
      } else if (folder === "static") {
        addStaticFolder(state.appID, state.workSpace.description!);
      }
    } else {
      LoggingService.logWarning('Canceled');
    }
  } else {
    window.showWarningMessage(`dbFlux: You have to add at least one Workspace inside an ${folder} Schema-Folder. Just use command dbFlux: Add Workspace`);
  }
}


export async function addHookFile(context: ExtensionContext) {
  interface State {
    title:      string;
    step:       number;
    totalSteps: number;
    folder:     QuickPickItem;
    name:       string
  }

  async function collectInputs() {
    const state = {} as Partial<State>;

    await MultiStepInput.run(input => pickHookFolder(input, state));
    return state as State;
  }




  async function pickHookFolder(input: MultiStepInput, state: Partial<State>) {
    state.folder = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 2,
      placeholder: 'Pick a .hook folder',
      items: objectTypes,
      activeItem: objectTypes[0],
      shouldResume: shouldResume,
      canSelectMany:false
    });

    return (input: MultiStepInput) => inputObjectName(input, state);
  }

  async function inputObjectName(input: MultiStepInput, state: Partial<State>) {
    state.name = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 2,
      value: state.name || '',
      prompt: 'Enter file name',
      validate: validateValueIsRequiered,
      shouldResume: shouldResume
    });

  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      // noop
    });
  }

  async function validateValueIsRequiered(name: string) {
    // eslint-disable-next-line eqeqeq
    return (name == undefined || name.length === 0) ? 'Value is required' : undefined;
  }


  const title = 'Add .hook file';
  const objectTypes = await getAvailableFolders(".hooks");

  if (objectTypes.length > 0) {
    const state = await collectInputs();

    if (state.name) {
      addHookFileToPath(state.folder.label, state.name);
    } else {
      LoggingService.logWarning('Canceled');
    }
  }
}


async function getFirstValidSubfolder(context:ExtensionContext): Promise<string> {
  const wsRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (wsRoot) {
    const projectInfos = await getProjectInfos(context);


    const sourceDB = path.join(wsRoot, ConfigurationManager.getDBFolderName());
    const getSchemaFolders = (source: PathLike) => readdirSync(source, { withFileTypes: true })
    .filter((dirent) => {
      return dirent.isDirectory() && !["_setup", ".setup", "dist", ".hooks"].includes(dirent.name);
    })
    .map((dirent) => dirent.name);

    if (projectInfos.isFlexMode) {
      return getSchemaFolders(sourceDB)[0];
    } else {
      return projectInfos.dataSchema;
    }
  }

  return "demo";
}


export async function addCustomTriggerRun(context:ExtensionContext) {
  const workspaceFolder = workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
      window.showErrorMessage("dbFlux: No workspace opened");
      return;
  }

  // path to settings.json
  const settingsUri = workspaceFolder.uri.with({
    path: workspaceFolder.uri.path + "/.vscode/settings.json"
  });

  try {
    // Prüfen, ob settings.json existiert, ansonsten anlegen
    let settingsDoc;
    try {
        settingsDoc = await workspace.fs.readFile(settingsUri);
    } catch (err) {
        settingsDoc = Buffer.from("{}"); // Falls nicht vorhanden, mit leerem JSON starten
    }

    // JSON-Inhalt parsen
    let settings = jsonc.parse(settingsDoc.toString());

    // Falls dbFlux.customTriggerRuns nicht existiert, initialisieren
    if (!settings["dbFlux.customTriggerRuns"]) {
        settings["dbFlux.customTriggerRuns"] = [];
    }


    const folderName = await getFirstValidSubfolder(context);
    // Neues Element, das hinzugefügt werden soll
    const newTrigger = {
        "triggeringExpression": `db\\/${folderName}\\/(tables|tables/tables_ddl)\\/.+\\.sql`,
        "runFile": `db/${folderName}/.hooks/post/010_demo.tables.sql`,
        "runFileParameters": ["dev", "dev", "${fileBasename}"]
    };

    // Neuen Trigger hinzufügen
    settings["dbFlux.customTriggerRuns"].push(newTrigger);

    // Änderungen in settings.json speichern
    const edits = jsonc.modify(settingsDoc.toString(), ["dbFlux.customTriggerRuns"], settings["dbFlux.customTriggerRuns"], { formattingOptions: { insertSpaces: true, tabSize: 4 } });
    const updatedSettings = jsonc.applyEdits(settingsDoc.toString(), edits);

    await workspace.fs.writeFile(settingsUri, Buffer.from(updatedSettings));

    // Open the settings file in the editor
    const document = await workspace.openTextDocument(settingsUri);
    await window.showTextDocument(document);

    window.showInformationMessage("dbFlux: New CustomTriggerRun added!\n\nYou have to edit the path and filename to make this work by your own.");

  } catch (error) {
      window.showErrorMessage("dbFlux: Error when editing settings.json: " + error);
  }
}

async function getAvailableFolders(folderserach: string): Promise<QuickPickItem[]> {
  if (workspace.workspaceFolders !== undefined) {
    const folders = await getAvailableObjectTypes();
    const filteredFolder = folders.filter((qitem) => qitem.label.split("/").includes(folderserach));
    // const appItems = apps.map(function(element){return {"label":path.parse(element).name, "description":element , "alwaysShow": true};});
    return filteredFolder;
  }
  return [{label: "", description:""}];
}

async function getAvailableWorkSpaces(folder:string): Promise<QuickPickItem[]> {
  if (workspace.workspaceFolders !== undefined) {
    const rootPath = workspace.workspaceFolders[0].uri.fsPath;
    const source = path.join(rootPath, folder);

    const getSchemaFolders = (source: PathLike) =>
          readdirSync(source, { withFileTypes: true })
          .filter((dirent) => {
            return dirent.isDirectory();
          })
          .map((dirent) => dirent.name);

    const getWorkspaces = (source: PathLike, subFolders:string[]):string[] => {
            let folders:string[] = [];

            subFolders.forEach(folder => {
              const folderPath = path.join(source.toString(), folder);
                 const workspaces =
                   readdirSync(folderPath, { withFileTypes: true })
                    .filter((dirent) => {
                      return dirent.isDirectory();
                    })
                    .map((dirent) => {
                      return (folderPath + path.sep + dirent.name).replace(/\\/g, '/').replace(rootPath.replace(/\\/g, '/'), '');
                    });
                  folders = folders.concat(workspaces);
            });


             return folders;
          };
    const apps = getWorkspaces(source, getSchemaFolders(source));
    const appItems = apps.map(function(element){return {"label":path.parse(element).name, "description":element , "alwaysShow": true};});
    return appItems;
  }
  return [{label: "", description:""}];
}

export function addApplication(appID: string, folder: string) {
  if (workspace.workspaceFolders !== undefined && appID) {

    const dirName:string = path.join(workspace.workspaceFolders[0].uri.fsPath, `${folder}/f${appID}`);

    if (!existsSync(dirName)){
      mkdirSync(dirName, { recursive: true });
      commands.executeCommand('revealInExplorer', Uri.file(dirName));
      window.showInformationMessage(`Folder: ${folder}/f${appID} created. At next export you can export the application.`);
    }

    const staticFolder = (`${folder}`);
    addStaticFolder(appID, staticFolder );
  }
}

export function addAppPlugin(plugID: string, folder: string, targetAPPID: string) {
  if (workspace.workspaceFolders !== undefined && plugID) {
    const plugFolder = targetAPPID.replace("apex", folder)! + "/" + plugID.toUpperCase();
    const dirName:string = path.join(workspace.workspaceFolders[0].uri.fsPath, `${plugFolder}/src`);

    if (!existsSync(dirName)){
      mkdirSync(path.join(dirName, "js"), { recursive: true });
      mkdirSync(path.join(dirName, "css"));
      mkdirSync(path.join(dirName, "img"));



      commands.executeCommand('revealInExplorer', Uri.file(dirName));
    }

    const pluginJSONFile:string = path.join(workspace.workspaceFolders[0].uri.fsPath, `apexplugin.json`);
    let answers:string[] = []
    let optQuest:string = ""
    if (!existsSync(pluginJSONFile)) {
      answers = ["Yes", "No"]
      optQuest = "Create file apexplugin.json?"
    }

    window.showInformationMessage(`Folder: ${plugFolder} created. Have fun, developing your plugin. ${optQuest}`, ... answers)
    .then(async (answer) => {
      if (answer === "Yes") {
        const plugin =  {
          "name" :        "Give me an name",
          "version" :     "0.1.0",
          "description" : "Give me a nice description",
          "keywords" :    ["KEYWORDA", "KEYWORDB"],
          "homepage" :    "https://maybe.you.can.find.me.on.github.com",
          "bugs" : {
            "url" :       "https://maybe.you.can.find.me.on.github.com/issues",
            "email" :     "this.could.be.my@adress.com"
          },
          "license" :     "MIT",
          "commercial" :  "No",
          "author" : {
            "name" :      "Your Name",
            "email" :     "this.could.be.my@adress.com"
          },
          "repository" : {
            "type" :      "git",
            "url" :       "https://maybe.you.can.find.me.on.github.git"
          },
          "oracle" : {
            "versions" :  ["23.0.0"],
            "apex" : {
              "versions" :       ["23.1", "23.2", "24.1"],
              "plugin" : {
                "internalName" : plugID,
                "type" :         "item",
                "demo" :         "https://apex.oracle.com/some-kind-of-demo-app",
                "previewImage" : `https://maybe.you.can.find.me.on.github.com/${plugFolder}/src/img/demo.png`
              }
            }
          }
        };

        // write the file
        writeFileSync(pluginJSONFile, JSON.stringify(plugin, undefined, 2));

        // and open it
        workspace.openTextDocument(Uri.file(pluginJSONFile)).then(doc => {
          window.showTextDocument(doc, {preview: false});
        });
      }});

  }
}


export function addStaticFolder(appID: string, folder: string) {
  if (workspace.workspaceFolders !== undefined && appID) {
    const staticFolder = `${folder.replace('apex', 'static')}/f${appID}/src`;
    const dirName:string = path.join(workspace.workspaceFolders[0].uri.fsPath, staticFolder);

    if (!existsSync(dirName)){
      mkdirSync(path.join(dirName, "js"), { recursive: true });
      mkdirSync(path.join(dirName, "css"));
      mkdirSync(path.join(dirName, "img"));

      commands.executeCommand('revealInExplorer', Uri.file(dirName));
      window.showInformationMessage(`Folder: "${staticFolder}" created. Just place your JavaScript, CSS or any other file here, to build and upload`);
    }
  }
}

export async function getNewApplication(): Promise<string> {
  const value:string | undefined = await window.showInputBox({ prompt: "dbFlux add Application", placeHolder: "Enter APP-ID" });
  return value ? value : "";
}

export async function getNewAppPlugin(): Promise<string> {
  const value:string | undefined = await window.showInputBox({ prompt: "dbFlux add Plugin Static ID", placeHolder: "Enter STATIC-ID" });
  return value ? value : "";
}

export async function addRESTModule(context: ExtensionContext) {
  interface State {
    title: string;
    step: number;
    totalSteps: number;

    module: string;
    schema: QuickPickItem;
  }

  async function collectInputs() {
    const state = {} as Partial<State>;

    await MultiStepInput.run(input => pickSchemas(input, state));
    return state as State;
  }

  async function pickSchemas(input: MultiStepInput, state: Partial<State>) {
    state.schema = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 2,
      placeholder: 'Pick a schema',
      items: objectTypes,
      activeItem: objectTypes[0],
      shouldResume: shouldResume,
      canSelectMany: false
    });

    return (input: MultiStepInput) => inputObjectName(input, state);
  }

  async function inputObjectName(input: MultiStepInput, state: Partial<State>) {
    state.module = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 2,
      value: state.module || '',
      prompt: 'Enter ModuleName',
      validate: validateValueIsRequiered,
      shouldResume: shouldResume
    });

  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      // noop
    });
  }

  async function validateValueIsRequiered(name: string) {
    // eslint-disable-next-line eqeqeq
    return (name == undefined || name.length === 0) ? 'Value is required' : undefined;
  }

  const title = 'ADD REST Module';
  const folder = "rest";
  const objectTypes = await getAvailableSchemas(folder);

  if (objectTypes.length > 0) {
    const state = await collectInputs();

    if (state.module) {
      addRestModul(state.module, state.schema.description!);
    } else {
      LoggingService.logWarning('Canceled');
    }
  } else {
    window.showWarningMessage("dbFlux: You have to add at least one Schema-folder inside rest folder. Juse user Command dbFlux: Add Schema");
  }
}

async function getAvailableSchemas(folder:string): Promise<QuickPickItem[]> {
  if (workspace.workspaceFolders !== undefined) {
    const rootPath = workspace.workspaceFolders[0].uri.fsPath;
    const source = path.join(rootPath, folder);

    const getSchemaFolders = (source: PathLike) =>
          readdirSync(source, { withFileTypes: true })
          .filter((dirent) => {
            return dirent.isDirectory();
          })
          .map((dirent) => dirent.name);


    const schemas = getSchemaFolders(source);
    const schemaItems = schemas.map(function(element){return {"label":path.parse(element).name, "description":folder+"/"+element , "alwaysShow": true};});
    return schemaItems;
  }
  return [{label: "", description:""}];
}

export function addRestModul(modulName: string, folder: string) {
  //
  if (workspace.workspaceFolders !== undefined) {

    const dirName:string = path.join(workspace.workspaceFolders[0].uri.fsPath, `${folder}/modules/${modulName}`);

    if (!existsSync(dirName)){
      mkdirSync(dirName, { recursive: true });
      commands.executeCommand('revealInExplorer', Uri.file(dirName));
      window.showInformationMessage(`Folder: ${folder}/modules/${modulName} created. At next export you can export the module.`);
    }


  }
}

export async function getNewRestModule(): Promise<string> {
   const value:string | undefined = await window.showInputBox({ prompt: "dbFlux add REST Modul", placeHolder: "Enter module name" });
   return value ? value : "";
}

export async function addWorkspace(context: ExtensionContext) {
  interface State {
    title: string;
    step: number;
    totalSteps: number;

    workspace: string;
    schema: QuickPickItem;
  }

  async function collectInputs() {
    const state = {} as Partial<State>;

    await MultiStepInput.run(input => pickSchemas(input, state));
    return state as State;
  }

  async function pickSchemas(input: MultiStepInput, state: Partial<State>) {
    const objectTypes = await getAvailableSchemas(folder);
    state.schema = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 2,
      placeholder: 'Pick a schema',
      items: objectTypes,
      activeItem: objectTypes[0],
      shouldResume: shouldResume,
      canSelectMany:false
    });

    return (input: MultiStepInput) => inputObjectName(input, state);
  }

  async function inputObjectName(input: MultiStepInput, state: Partial<State>) {
    state.workspace = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 2,
      value: state.workspace || '',
      prompt: 'Enter Workspace Name',
      validate: validateValueIsRequiered,
      shouldResume: shouldResume
    });

  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      // noop
    });
  }

  async function validateValueIsRequiered(name: string) {
    // eslint-disable-next-line eqeqeq
    return (name == undefined || name.length === 0) ? 'Value is required' : undefined;
  }

  const title = 'ADD Workspace Folder';
  const folder = "apex";

  if (getSubFolders("apex").length > 0) {
    const state = await collectInputs();

    if (state.workspace) {
      addWorkspaceFolder(state.workspace, state.schema.label);
    } else {
      LoggingService.logWarning('Canceled');
    }
  } else {
    window.showWarningMessage('dbFlux: You have to add at least one Schema inside apex-folder. Just use Command dbFlux: Add Schema');
  }
}

export function addWorkspaceFolder(workspaceName: string, schema: string) {

  if (workspace.workspaceFolders !== undefined) {
    const wsRootPath = workspace.workspaceFolders![0];
    [`apex/${schema}`, `static/${schema}`, `${ConfigurationManager.getDBFolderName()}/_setup/workspaces`].forEach(element => {
      const dirName:string = path.join(wsRootPath.uri.fsPath, element, `/${workspaceName}`);
      if (!existsSync(dirName)){
        mkdirSync(dirName, { recursive: true });
        commands.executeCommand('revealInExplorer', Uri.file(dirName));
      }
    });

    const createWSFile = writeCreateWorkspaceScript(workspaceName, schema);
    const createWSAdminFile = writeCreateWorkspaceAdminScript(workspaceName, "wsadmin", schema);

    rewriteInstall();

    const openScript = 'Open Script';
    window.showInformationMessage(`Schema: ${schema} created inside Folders: ${[`apex/${schema}`, `static/${schema}`, `${ConfigurationManager.getDBFolderName()}/_setup/workspaces`].join(',')}.
    Schema creation script written to _setup schema. Open to run it.`, openScript)
    .then(selection => {
      if (selection === openScript) {
        workspace.openTextDocument(Uri.file(path.join(wsRootPath.uri.fsPath, createWSFile))).then(doc => {
          window.showTextDocument(doc);
        });

        workspace.openTextDocument(Uri.file(path.join(wsRootPath.uri.fsPath, createWSAdminFile))).then(doc => {
          window.showTextDocument(doc, {preview: false, viewColumn: ViewColumn.Beside});
        });
      };
    });

  }
}

export async function addSchema(context: ExtensionContext) {
  interface State {
    title: string;
    step: number;
    totalSteps: number;

    schema: string;
    folders: QuickPickItem;
  }

  async function collectInputs() {
    const state = {} as Partial<State>;

    await MultiStepInput.run(input => pickAMainFolder(input, state));
    return state as State;
  }

  const title = 'ADD Schema';

  async function pickAMainFolder(input: MultiStepInput, state: Partial<State>) {
    const folders:QuickPickItem[] = await getMainFolders();
    state.folders = await input.showQuickPick({
      title,
      step: 1,
      totalSteps: 2,
      placeholder: 'Select one or more target folder',
      canSelectMany: true,
      items: folders,
      activeItem: folders[1],
      shouldResume: shouldResume
    });

    return (input: MultiStepInput) => inputObjectName(input, state);
  }

  async function inputObjectName(input: MultiStepInput, state: Partial<State>) {
    state.schema = await input.showInputBox({
      title,
      step: 2,
      totalSteps: 2,
      value: state.schema || '',
      prompt: 'Enter Schema Name',
      validate: validateValueIsRequiered,
      shouldResume: shouldResume
    });

  }

  function shouldResume() {
    // Could show a notification with the option to resume.
    return new Promise<boolean>((resolve, reject) => {
      // noop
    });
  }

  async function validateValueIsRequiered(name: string) {
    // eslint-disable-next-line eqeqeq
    return (name == undefined || name.length === 0) ? 'Value is required' : undefined;
  }

  const state = await collectInputs();
  if (state.schema) {
    addMainFolders(state.schema, state.folders, await getProjectInfos(context));
  } else {
    LoggingService.logWarning('Canceled');
  }
}

async function getMainFolders(): Promise<QuickPickItem[]> {
  if (workspace.workspaceFolders !== undefined) {
    const rootPath = workspace.workspaceFolders[0].uri.fsPath;
    const source = rootPath;

    const getMFolders = (source: PathLike) =>
          readdirSync(source, { withFileTypes: true })
          .filter((dirent) => {
            return dirent.isDirectory() && ["apex", ConfigurationManager.getDBFolderName(), "rest", "static"].includes(dirent.name);
          })
          .map((dirent) => dirent.name);


    const folders = getMFolders(source);
    const folderItems = folders.map(function(element){return {"label":path.parse(element).name, "description":element , "alwaysShow": true};});
    return folderItems;
  }
  return [{label: "", description:""}];
}

function addMainFolders(schema: string, folders: any, projectInfos:IProjectInfos) {
  if (workspace.workspaceFolders !== undefined) {
    const wsRootPath = workspace.workspaceFolders[0].uri.fsPath;
    if (folders.length && folders.length > 0) {
      let foldersCreated : string[] = [];
      folders.forEach((wsPath: any) => {
        if (wsPath.description) {
          const dirName:string = path.join(wsRootPath, `${wsPath.description}/${schema}`);

          // make folder
          if (!existsSync(dirName)){
            mkdirSync(dirName, { recursive: true });
            foldersCreated.push(wsPath.description);
            commands.executeCommand('revealInExplorer', Uri.file(dirName));
          }

          // create db folder structure
          if (wsPath.description === ConfigurationManager.getDBFolderName()) {
            createDirectoryPath(dbFolderDef, "/", dirName) ;
          }

          if (wsPath.description === "rest") {
            createDirectoryPath(restFolderDef, "/", dirName) ;
          }
        }
      });

      if (foldersCreated.length>0) {
        const createdFile = writeUserCreationScript(-1, schema, projectInfos.projectName!);

        rewriteInstall();

        const openScript = 'Open Script';
        window.showInformationMessage(`Schema: ${schema} created inside Folders: ${foldersCreated.join(',')}. Schema creation script written to _setup folder. Open to run it.`, openScript)
        .then(selection => {
          if (selection === openScript) {
            const openPath = Uri.file(path.join(wsRootPath, createdFile));
            workspace.openTextDocument(openPath).then(doc => {
              window.showTextDocument(doc);
            });
          };
        });
      }
    } else {
      window.showWarningMessage(`dbFlux: No mainfolder selected (apex, ${ConfigurationManager.getDBFolderName()}, rest, static)`);
    }
  }
}


export function registerAddRESTModuleCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addREST", async () => {

    if (projectInfos.isFlexMode) {
      addRESTModule(context);
    } else {
      addRestModul(await getNewRestModule(), "rest");
    }

  });
}

export function registerAddReportTypeFolderCommand() {
  return commands.registerCommand("dbFlux.addReportFolder", async () => {
    ExportTaskStore.getInstance().addReportTypeFolder(await ExportTaskStore.getInstance().getReportType());
  });
}

export function registerAddHookFileCommand(context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addHookFile", async () => {
    addHookFile(context)
  });
}

export function registerAddCustomtriggerRunCommand(context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addCustomTriggerRun", async () => {
    addCustomTriggerRun(context)
  });
}


export function registerAddStaticApplicationFolderCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addStaticFolder", async () => {
    if (projectInfos.isFlexMode) {
      addAPEXApp(context, "static");
    } else {
      addStaticFolder(await getNewApplication(), "static");
    }

  });
}

export function registerAddSchemaCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addSchema", async () => {
    if (projectInfos.isFlexMode) {
      addSchema(context);
    } else {
      window.showWarningMessage('dbFlux: You have to set Project Mode to "FLEX" to add a Schema');
    }
  });
}

export function registerAddWorkspaceCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addWorkspace", async () => {
    if (projectInfos.isFlexMode) {
      addWorkspace(context);
    } else {
      window.showWarningMessage('dbFlux: You have to set Project Mode to "FLEX" to add a Workspace');
    }

  });
}

export function registerAddApplicationCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addAPP", async () => {
    if (projectInfos.isFlexMode) {
      addAPEXApp(context, "apex");
    } else {
      addApplication(await getNewApplication(), "apex");
    }

  });
}

export function registerAddApplicationPluginCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.addAPP.plugin", async () => {
    // choose APP Folder
    const targetAPPID = await ExportTaskStore.getInstance().getAppID(projectInfos, false);

    if (targetAPPID) {
      LoggingService.logDebug(`Target Appication selected: ${targetAPPID}`);
      addAppPlugin(await getNewAppPlugin(), "plugin", targetAPPID!);
    }
  });
}


export function registerSplitToFilesCommand(projectInfos: IProjectInfos) {
  return commands.registerCommand("dbFlux.splitToFiles", async () => {
    const fileName = window.activeTextEditor?.document.fileName.split(path.sep).join(path.posix.sep)!;
    const wsRoot = getWorkspaceRootPath();
    const dbUser = getDBUserFromPath(fileName, projectInfos);
    const dirName = path.join(wsRoot, ConfigurationManager.getDBFolderName(), dbUser);


    const fileArray:String[] = [];
    let splitted = false;

    // read file
    const splittedContent = readFileSync(fileName, "utf-8").split(ConfigurationManager.fileSeparation);
    const lineSpliter = splittedContent[0]?.indexOf("\r") >= 0 ? "\r\n" : "\n";

    // loop over content
    splittedContent.forEach(function(content, index){
       if (index > 0) {
        // get lines and filename
        const lines = content.split(lineSpliter);
        const newFileName = lines[0].startsWith("../")?lines[0].substring(3):lines[0];

        lines.shift();

        if (lines.length > 0 && lines[0] !== "") {
          mkdirSync(path.dirname(dirName + '/' + newFileName), {recursive:true});
          writeFileSync(dirName + '/' + newFileName, lines.join(lineSpliter).trim());
          fileArray.push(newFileName);
          splitted = true;
        }
       }

    });

    if (splitted) {
      writeFileSync(fileName, splittedContent[0] + ConfigurationManager.fileSeparation + fileArray.join(lineSpliter + ConfigurationManager.fileSeparation) + lineSpliter);
      showInformationProgress("dbFlux: file successfully splitted", 3000);
    } else {
      window.showWarningMessage("dbFlux: nothing found to split by! You have to put -- File: ../relative/path/to/file.sql below contend to be splitted");
    }
  });
}

export function registerJoinFromFilesCommand(projectInfos: IProjectInfos) {
  return commands.registerCommand("dbFlux.joinFiles", async () => {
    const fileName = window.activeTextEditor?.document.fileName.split(path.sep).join(path.posix.sep)!;
    const wsRoot = getWorkspaceRootPath();
    const dbUser = getDBUserFromPath(fileName, projectInfos);
    const dirName = path.join(wsRoot, ConfigurationManager.getDBFolderName(), dbUser);
    let joined = false;

    // read file
    const splittedContent = readFileSync(fileName, "utf-8").split(ConfigurationManager.fileSeparation);
    const lineSpliter = splittedContent[0]?.indexOf("\r") >= 0 ? "\r\n" : "\n";

    // loop over content
    splittedContent.forEach(function(content, index){
      if (index > 0) {
        const fName = content.replace(lineSpliter, '');
        const readFileName = dirName + '/' + (fName.startsWith("../") ? fName.substring(3) : fName);

        if (existsSync(readFileName)) {
          const fileContent = readFileSync(readFileName, "utf-8");
          splittedContent[index] = content + fileContent + "\n";
          joined = true;
        }
      }
    });


    if (joined) {
      writeFileSync(fileName, splittedContent.join(ConfigurationManager.fileSeparation));
      showInformationProgress("dbFlux: files successfully joined", 3000);
    } else {
      window.showWarningMessage("dbFlux: nothing found to join! You have to use: -- File: ../relative/path/to/file.sql to refer to files which should be joined");
    }
  });
}



export function registerReverseBuildFromFilesCommand(projectInfos: IProjectInfos) {
  return commands.registerCommand("dbFlux.reverseBuildFromFiles", async () => {
    const fileName = window.activeTextEditor?.document.fileName.split(path.sep).join(path.posix.sep)!;
    const tablename = path.basename(fileName).split('.')[0].toLowerCase();


    const wsRoot = getWorkspaceRootPath();

    const dbUser = getDBUserFromPath(fileName, projectInfos);
    const dirName = path.join(wsRoot, ConfigurationManager.getDBFolderName(), dbUser).replace(/\\/g, '/');
    let joined = false;

    // loop through all constraint files with the tablename
    let files:any  = [];

    const readFiles = (directory: string) => {
      readdirSync(directory).forEach(file => {
        const absolutFileName = path.join(directory, file);
        if (statSync(absolutFileName).isDirectory()) return readFiles(absolutFileName);
          else return files.push(absolutFileName);
      });
    }

    readFiles(path.join(dirName, 'indexes/primaries'));
    readFiles(path.join(dirName, 'indexes/uniques'));
    readFiles(path.join(dirName, 'indexes/defaults'));

    readFiles(path.join(dirName, 'constraints/primaries'));
    readFiles(path.join(dirName, 'constraints/uniques'));
    readFiles(path.join(dirName, 'constraints/foreigns'));
    readFiles(path.join(dirName, 'constraints/checks'));

    readFiles(path.join(dirName, 'sources/triggers'));

    files = files.filter((file:string) => {
      if (file.toLowerCase().includes(tablename)) {
        const fContent = readFileSync(file, "utf-8").replace(/[\r\n]+/g," ").replace(/\s{2,}/g,' ').replace(/\(/g,' (').toLowerCase().replace(/ +(?= )/g,'');
        return (   fContent.includes(`alter table ${tablename} add`)
                || fContent.includes(` on ${tablename} (`)
                || fContent.includes(` on ${tablename} for`)
              );
      } else {
        return false;
      }
    }).map((file:string) => "-- File: " + file.replace(/\\/g, '/').replace(dirName+"/", ''));

    if (files.length > 0) {
      appendFileSync(fileName, "\n\n-- dbFlux reverse scanned ... \n" + files.join("\n"));
      showInformationProgress("dbFlux: files successfully scanned your files", 3000);
    } else {
      window.showWarningMessage("dbFlux: nothing found ... \n Files have to include tablename.");
    }


  });
}


function findFileWithHighestIndex(pathToRead:string, filePrefix:string): string|undefined {
  const files = readdirSync(pathToRead);

  const matchingFiles = files.filter(file => file.startsWith(filePrefix+".") && file.endsWith('.sql'));

  let maxIndex = -1;
  let maxFile = undefined;

  matchingFiles.forEach(file => {
    // extract number between dots "a_table.3.sql" -> 3
    const match = file.match(/a_table\.(\d+)\.sql/);
    if (match && match[1]) {
      const index = parseInt(match[1], 10);
      if (index > maxIndex) {
        maxIndex = index;
        maxFile = file;
      }
    }
  });

  return maxFile;
}

export function registerOpenSpecOrBody() {
  return commands.registerCommand("dbFlux.openSpecOrBody", async () => {
    // currentFilename
    const fileName = window.activeTextEditor?.document.fileName;
    if (fileName) {

      let fileNameNew = fileName;
      const extension = path.extname(fileName);
      const pathes = fileName.split(path.sep);

      // remove filename from Array (last element)
      pathes.pop();

      // dependend from last folder
      if (pathes[pathes.length-1] == "tables") {
        // find matching file with max index
        pathes.push("tables_ddl");
        pathes.push(findFileWithHighestIndex(pathes.join(path.sep)!, path.basename(fileName).split(".")[0])!);

        fileNameNew = pathes.join(path.sep);
      } else if (pathes[pathes.length-1] == "tables_ddl") {
        // find matching file without index
        pathes.pop();
        pathes.push(path.basename(fileName).split(".")[0]+extension);

        fileNameNew = pathes.join(path.sep);
      } else if (pathes[pathes.length-1] == "packages") {
        // switch based on extension
        if ([".pks", ".pkb", ".tps", ".tpb"].includes(extension.toLowerCase())) {
          let extensionNew = "xxx";
          if (extension === ".pks") {
            extensionNew = ".pkb";
          } else if (extension === ".PKS") {
            extensionNew = ".PKB";
          } else if (extension === ".pkb") {
            extensionNew = ".pks";
          } else if (extension === ".PKB") {
            extensionNew = ".PKS";
          } else if (extension === ".tps") {
            extensionNew = ".tpb";
          } else if (extension === ".TPS") {
            extensionNew = ".TPB";
          } else if (extension === ".tpb") {
            extensionNew = ".tps";
          } else if (extension === ".TPB") {
            extensionNew = ".TPS";
          }

          fileNameNew = fileName.replace(extension, extensionNew);
        }
      }

      if (existsSync(fileNameNew)) {
        if (fileName != fileNameNew) {
          LoggingService.logInfo('Switch to file: ' + workspace.asRelativePath(fileNameNew));
          workspace.openTextDocument(Uri.file(fileNameNew)).then(doc => {
            window.showTextDocument(doc, {preview: false});
          });
        }
      }
    }
  });
}



export function registerCopySelectionWithFilenameToClipBoard() {
  return commands.registerCommand("dbFlux.copySelectionWithFilenameToClipBoard", async () => {
    const fileName = window.activeTextEditor?.document.fileName;

    if (fileName) {
      const extension = path.extname(fileName);
      if ([".pks", ".pkb", ".tps", ".tpb"].includes(extension.toLowerCase())) {
        const packageName = path.basename(fileName).split('.')[0].toLowerCase();

        copyWithSection(packageName);
      } else {
        if (extension.toLowerCase() === ".sql" && isTableFile(fileName)) {
          const tableName = path.basename(fileName).split('.')[0].toLowerCase();

          copyWithSection(tableName);
        }
      }
    }
  });
}

function copyWithSection(objectName: string) {
  const editor = window.activeTextEditor!;
  const selection = editor.selection;
  if (selection && !selection.isEmpty) {
    const selectionRange = new Range(selection.start.line, selection.start.character, selection.end.line, selection.end.character);
    const highlighted = editor.document.getText(selectionRange);

    env.clipboard.writeText(objectName + '.' + highlighted);
    window.setStatusBarMessage('dbFlux: ' + objectName + '.' + highlighted + ' written to ClipBoard', 2000);
  }
}

function addHookFileToPath(folder: string, filename: string) {
  const wsRoot   = getWorkspaceRootPath();
  const dirName  = path.join(wsRoot, folder);
  const baseF    = rtrim(path.basename(filename), ".sql");
  const fullFile = dirName + '/' + baseF + ".sql";

  const tmplFileName = (folder.startsWith(".hooks") || folder.startsWith("${ConfigurationManager.getDBFolderName()}/.hooks")) ? "globalhook.tmpl.sql" : "hook.tmpl.sql"
  const template = readFileSync(path.resolve(__dirname, "..", "..", "dist", "templates", tmplFileName).split(path.sep).join(path.posix.sep), "utf8");

  if (!existsSync(dirName)) {
    mkdirSync(dirName);
  }
  writeFileSync(fullFile, template);

  if (existsSync(fullFile)) {
    workspace.openTextDocument(Uri.file(fullFile)).then(doc => {
      window.showTextDocument(doc, {preview: false});
    });
  }
}
function isTableFile(filename: string):boolean {
  return filename.includes(path.sep + 'tables' + path.sep)
}
