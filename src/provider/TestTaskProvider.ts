/* eslint-disable @typescript-eslint/naming-convention */

import { commands, ExtensionContext, QuickPickItem, ShellExecution, Task, TaskDefinition, TaskProvider, tasks, TaskScope, Uri, ViewColumn, WebviewPanel, window, workspace } from "vscode";
import * as path from "path";

import { getWorkingFile, getWorkspaceRootPath, matchRuleShort } from "../helper/utilities";
import { AbstractBashTaskProvider, getDBSchemaFolders, getDBUserFromPath, getProjectInfos, IBashInfos, IProjectInfos } from "./AbstractBashTaskProvider";
import { ConfigurationManager } from "../helper/ConfigurationManager";
import { TestTaskStore } from "../stores/TestTaskStore";
import { CompileTaskStore, setAppPassword } from "../stores/CompileTaskStore";
import { outputLog } from "../helper/OutputChannel";
import { existsSync, readFileSync } from "fs";
import { removeSync } from "fs-extra";


const which = require('which');

interface TestTaskDefinition extends TaskDefinition {
  name: string;
  runner: ISQLTestInfos;
}

interface ISQLTestInfos extends IBashInfos {
  connectionArray:    string[];
  executableCli:      string;
  fileToTest:         string;
}

export class TestTaskProvider extends AbstractBashTaskProvider implements TaskProvider {
  static dbFluxType: string = "dbFlux";

  constructor(context: ExtensionContext, private mode:string){
    super(context);
  };

  provideTasks(): Thenable<Task[]> | undefined {
    return this.getTestTasks();
  }

  resolveTask(task: Task): Task | undefined {
    return task;
  }


  async getTestTasks(): Promise<Task[]> {
    const result: Task[] = [];

    const runTask: ISQLTestInfos = await this.prepTestInfos();

    result.push(this.createTestTask(this.createTestTaskDefinition(this.mode, runTask)));

    return Promise.resolve(result);
  }

  createTestTaskDefinition(name: string, runner: ISQLTestInfos): TestTaskDefinition {
    return {
      type: TestTaskProvider.dbFluxType,
      name,
      runner,
    };
  }

  createTestTask(definition: TestTaskDefinition): Task {
    let _task = new Task(
      definition,
      TaskScope.Workspace,
      definition.name,
      TestTaskProvider.dbFluxType,
      new ShellExecution(definition.runner.runFile, definition.runner.connectionArray, {
        env: {
          DBFLOW_SQLCLI:     definition.runner.executableCli,
          DBFLOW_DBTNS:      definition.runner.connectionTns,
          DBFLOW_DBPASS:     definition.runner.connectionPass,
          DBFLOW_FILE2TEST:  this.mode === "executeTests" ? "" : definition.runner.fileToTest
        }
      })

    );
    _task.presentationOptions.echo = false;


    return _task;
  }

  async prepTestInfos(): Promise<ISQLTestInfos> {
    let runner: ISQLTestInfos = {} as ISQLTestInfos;

    if (workspace.workspaceFolders) {
      let fileUri:Uri = workspace.workspaceFolders[0].uri;
      let apexUri:Uri = Uri.file(path.join(fileUri.fsPath, 'apex/f0000/install.sql'));

      if (apexUri !== undefined) {
        this.setInitialCompileInfo("test.sh", apexUri, runner);
        const projectInfos = getProjectInfos(this.context);
        if (TestTaskStore.getInstance().selectedSchemas) {
          runner.connectionArray = TestTaskStore.getInstance().selectedSchemas!.map((element) =>{
            return '"' + this.buildConnectionUser(projectInfos, element) +'"';
          });
        };

        runner.fileToTest = "" + TestTaskStore.getInstance().fileName;

        runner.executableCli      = ConfigurationManager.getCliToUseForCompilation();

      }
    }

    return runner;
  }

}


export function registerExecuteTestPackageCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.executeTestPackage", async () => {

    if (projectInfos.isValid) {

      // check what file has to build
      let fileName = await getWorkingFile();

      // now check connection infos
      setAppPassword(projectInfos);


      if (CompileTaskStore.getInstance().appPwd !== undefined) {
        // const insidePackages = matchRuleShort(fileName, '*/db/*/sources/packages/*');
        const insideTests = matchRuleShort(fileName, '*/db/*/tests/packages/*');
        const fileExtension: string = "" + fileName.split('.').pop();
        const extensionAllowed = ConfigurationManager.getKnownSQLFileExtensions();


        if (extensionAllowed.map(ext => ext.toLowerCase()).includes(fileExtension.toLowerCase()) && (insideTests)) {
          which(ConfigurationManager.getCliToUseForCompilation()).then(async () => {
            TestTaskStore.getInstance().selectedSchemas = ["db/" + getDBUserFromPath(fileName, projectInfos)];
            TestTaskStore.getInstance().fileName = fileName;

            context.subscriptions.push(tasks.registerTaskProvider("dbFlux", new TestTaskProvider(context, "executeTestPackage")));
            commands.executeCommand("workbench.action.tasks.runTask", "dbFlux: executeTestPackage");
          }).catch(() => {
            window.showErrorMessage(`dbFlux: No executable ${ConfigurationManager.getCliToUseForCompilation()} found on path!`);
          });
        } else {
          window.showWarningMessage('Current filetype is not supported by dbFlux ...');
        }
      }
    }
  });
}

export function registerExecuteTestsTaskCommand(projectInfos: IProjectInfos, context: ExtensionContext) {
  return commands.registerCommand("dbFlux.executeTests", async () => {
    if (projectInfos.isValid) {
      setAppPassword(projectInfos);

      if (CompileTaskStore.getInstance().appPwd !== undefined) {

        let schemaSelected: boolean = false;
        const dbSchemaFolders = await getDBSchemaFolders();
        if (dbSchemaFolders.length > 1) {

          const items: QuickPickItem[] | undefined = await window.showQuickPick(dbSchemaFolders, {
            canPickMany: true, placeHolder: 'Choose Schema to run your tests'
          });
          schemaSelected = (items !== undefined && items?.length > 0);
          TestTaskStore.getInstance().selectedSchemas = items?.map(function (element) { return element.description!; });
        } else if (dbSchemaFolders.length === 1) {
          schemaSelected = true;
          TestTaskStore.getInstance().selectedSchemas = dbSchemaFolders?.map(function (element) { return element.description!; });
        }

        if (schemaSelected) {
          which(ConfigurationManager.getCliToUseForCompilation()).then(async () => {
            context.subscriptions.push(tasks.registerTaskProvider("dbFlux", new TestTaskProvider(context, "executeTests")));
            await commands.executeCommand("workbench.action.tasks.runTask", "dbFlux: executeTests");
          }).catch((error: any) => {
            outputLog(error);
            window.showErrorMessage(`dbFlux: No executable ${ConfigurationManager.getCliToUseForCompilation()} found on path!`);
          });
        }
      }
    }
  });
}

export function openTestResult(context: ExtensionContext, webViewTestPanel: WebviewPanel | undefined){
  const wsRoot = getWorkspaceRootPath();
  const logFile = path.join(wsRoot, "utoutput.log");

  if ( existsSync(logFile)) {
    const logContent = readFileSync(logFile, "utf8");

    var Convert = require('ansi-to-html');
    var convert = new Convert({fg: '#FFF',
                               bg: '#222',
                               newline: true});

    const htmlContent = convert.toHtml(logContent);
    removeSync(logFile);

    // Create and show panel
    if (!webViewTestPanel) {
      webViewTestPanel = window.createWebviewPanel(
        'dbFLux ',
        'dbFlux - utPLSQL UnitTest Output',
        ViewColumn.Beside,
        {}
      );
    }

    // And set its HTML content
    webViewTestPanel.webview.html = /*html*/ `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>dbFLux - utPLSQL - output</title>
    </head>
    <body>
       ${htmlContent}
    </body>
    </html>`;

    context.subscriptions.push(window.setStatusBarMessage(`Tests completed, Showing Output as Html`));

    return webViewTestPanel;
  }
}