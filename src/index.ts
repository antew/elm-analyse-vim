#!/usr/bin/env node

import {
  createConnection,
  TextDocuments,
  TextDocument,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  DidChangeConfigurationNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams
} from "vscode-languageserver";

import { spawn } from "child_process";
import * as path from "path";
import fetch from "node-fetch";
import * as url from "url";
import * as fs from "fs";

// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);
let elmAnalyseProcess;

const log = function(str: string) {
  fs.appendFileSync("asdf.log", str + "\n");
};
// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function uri2path(uri: string): string {
  const parts = url.parse(uri);
  if (parts.protocol !== "file:") {
    throw new Error("Cannot resolve non-file uri to path: " + uri);
  }

  let filePath = parts.pathname || "";

  // If the path starts with a drive letter, return a Windows path
  if (/^\/[a-z]:\//i.test(filePath)) {
    filePath = filePath.substr(1).replace(/\//g, "\\");
  }

  return decodeURIComponent(filePath);
}
function startElmAnalyse(cwd) {
  log(`startElmAnalyse, ${cwd} ${uri2path(cwd)}`);
  return spawn(
    path.resolve(__dirname, "../node_modules/.bin/elm-analyse"),
    ["-s", "-p 3002"],
    { cwd: uri2path(cwd) }
  );
}

connection.onInitialize((params: InitializeParams) => {
  let capabilities = params.capabilities;

  log(`InitializeParams ${JSON.stringify(params)}`);
  elmAnalyseProcess = startElmAnalyse(params.rootUri);
  elmAnalyseProcess.stdout.on("data", function(data) {
    console.log(data.toString());
    fs.appendFileSync("asdf.log", data);
  });

  elmAnalyseProcess.on("exit", function(code, signal) {
    log("child process exited with " + `code ${code} and signal ${signal}`);
  });
  // Does the client support the `workspace/configuration` request?
  // If not, we will fall back using global settings
  hasConfigurationCapability = !!(
    capabilities.workspace && !!capabilities.workspace.configuration
  );
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && !!capabilities.workspace.workspaceFolders
  );
  hasDiagnosticRelatedInformationCapability = !!(
    capabilities.textDocument &&
    capabilities.textDocument.publishDiagnostics &&
    capabilities.textDocument.publishDiagnostics.relatedInformation
  );

  console.log(
    "Connection onInitialize: hasConfigurationCapability",
    capabilities
  );
  log(
    `Connection onInitialize: hasConfigurationCapability ${JSON.stringify(
      capabilities
    )}`
  );
  return {
    capabilities: {
      textDocumentSync: documents.syncKind,
      // Tell the client that the server supports code completion
      completionProvider: {
        resolveProvider: true
      }
    }
  };
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    // Register for all configuration changes.
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined
    );
  }
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders(_event => {
      connection.console.log("Workspace folder change event received.");
    });
  }
});

// The example settings
interface ExampleSettings {
  maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
  log(`Configuration changed ${JSON.stringify(change)}`);
  if (hasConfigurationCapability) {
    // Reset all cached document settings
    documentSettings.clear();
  } else {
    globalSettings = <ExampleSettings>(
      (change.settings.languageServerExample || defaultSettings)
    );
  }

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
  log(`Get document settings ${resource}`);
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource,
      section: "languageServerExample"
    });
    documentSettings.set(resource, result);
  }
  return result;
}

// Only keep settings for open documents
documents.onDidClose(e => {
  documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
  log(`Document changed  ${JSON.stringify(change)}`);
  validateTextDocument(change.document);
});

async function fetchElmAnalyseState() {
  return fetch("http://localhost:3002/report")
    .then(res => res.json())
    .catch(err => {
      log(`Error fetching elm analyse state ${err}`);
      return sleep(2000).then(fetchElmAnalyseState);
    });
}

function publishDiagnostics(messages, uri) {
  // Filter messages to the currently open file
  let currentMessages = (messages || []).filter(m => uri.endsWith(m.file));
  let diagnostics: Diagnostic[] = currentMessages.map(message => {
    let [lineStart, colStart, lineEnd, colEnd] = message.data.properties.range;
    let diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: lineStart - 1, character: colStart - 1 },
        end: { line: lineEnd - 1, character: colEnd - 1 }
      },
      // Clean up the error message a bit, removing the end of the line
      // Record has only one field. Use the field's type or introduce a Type. At ((14,5),(14,20))  )
      message: message.data.description.split(/at .+$/i)[0],
      source: "elm-analyse-vim"
    };
    if (hasDiagnosticRelatedInformationCapability) {
      diagnostic.relatedInformation = [
        {
          location: {
            uri: uri,
            range: Object.assign({}, diagnostic.range)
          },
          message: message.type
        }
      ];
    }
    return diagnostic;
  });
  log(`Sending diagnostics ${JSON.stringify(diagnostics)}`);

  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: uri, diagnostics });
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  // In this simple example we get the settings for every validate run.
  let settings = await getDocumentSettings(textDocument.uri);

  fetchElmAnalyseState()
    .then(body => publishDiagnostics(body.messages, textDocument.uri))
    .catch(err => log(`Uh oh, errored ${err}`));
}

connection.onDidChangeWatchedFiles(_change => {
  // Monitored files have change in VSCode
  connection.console.log("We received an file change event");
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
  (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    // The pass parameter contains the position of the text document in
    // which code complete got requested. For the example we ignore this
    // info and always provide the same completion items.
    return [
      {
        label: "TypeScript",
        kind: CompletionItemKind.Text,
        data: 1
      },
      {
        label: "JavaScript",
        kind: CompletionItemKind.Text,
        data: 2
      }
    ];
  }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
  (item: CompletionItem): CompletionItem => {
    if (item.data === 1) {
      (item.detail = "TypeScript details"),
        (item.documentation = "TypeScript documentation");
    } else if (item.data === 2) {
      (item.detail = "JavaScript details"),
        (item.documentation = "JavaScript documentation");
    }
    return item;
  }
);

connection.onDidOpenTextDocument(params => {
  // A text document got opened in VSCode.
  // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
  // params.text the initial full content of the document.
  // connection.console.log(`${params.textDocument.uri} opened.`);
  log(`opened text document ${JSON.stringify(params)}`);
});
/*
connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});
connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
