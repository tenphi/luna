/**
 * In-process Apple Notes MCP server (AppleScript-backed).
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-notes-mcp` 1.0.0),
 * vendored in-tree by Luna. Raw tool names preserved for the tool-alias map.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

import { errorResult, textResult } from '../../shared/cli.js';
import { FIELD_DELIM, RECORD_DELIM, runAppleScript, sanitize } from '../shared/applescript.js';
import { confirmArg, confirmGuard, isReadOnly } from '../shared/safety.js';
import type { AppleAppConfig } from '../shared/types.js';

function noteScope(folder: string | undefined): string {
  return folder ? `notes of folder "${sanitize(folder)}"` : 'every note';
}

async function listFolders(): Promise<Array<{ name: string }>> {
  const raw = await runAppleScript(`
tell application "Notes"
  set folderList to {}
  repeat with f in folders
    set end of folderList to name of f
  end repeat
  set AppleScript's text item delimiters to "${FIELD_DELIM}"
  return folderList as text
end tell`);
  if (!raw) return [];
  return raw.split(FIELD_DELIM).map((name) => ({ name: name.trim() }));
}

async function createFolder(name: string): Promise<string> {
  const safeName = sanitize(name);
  return runAppleScript(`
tell application "Notes"
  make new folder with properties {name:"${safeName}"}
  return "Folder created: ${safeName}"
end tell`);
}

async function deleteFolder(name: string): Promise<string> {
  const safeName = sanitize(name);
  return runAppleScript(`
tell application "Notes"
  set targetFolder to first folder whose name is "${safeName}"
  delete targetFolder
  return "Folder deleted: ${safeName}"
end tell`);
}

async function listNotes(folder: string): Promise<Array<Record<string, string>>> {
  const safeFolder = sanitize(folder);
  const raw = await runAppleScript(`
tell application "Notes"
  set noteList to {}
  set theFolder to folder "${safeFolder}"
  repeat with n in notes of theFolder
    set noteId to id of n
    set noteTitle to name of n
    set noteCreated to creation date of n as text
    set noteModified to modification date of n as text
    set end of noteList to noteTitle & "${FIELD_DELIM}" & noteId & "${FIELD_DELIM}" & noteCreated & "${FIELD_DELIM}" & noteModified
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return noteList as text
end tell`);
  if (!raw) return [];
  return raw.split(RECORD_DELIM).map((record) => {
    const [title, id, creationDate, modificationDate] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { title, id, creationDate, modificationDate };
  });
}

async function getNote(title: string, folder?: string): Promise<Record<string, string>> {
  const safeTitle = sanitize(title);
  const raw = await runAppleScript(`
tell application "Notes"
  set matchedNotes to (${noteScope(folder)} whose name is "${safeTitle}")
  if (count of matchedNotes) is 0 then
    error "Note not found: ${safeTitle}"
  end if
  set n to item 1 of matchedNotes
  set noteTitle to name of n
  set noteId to id of n
  set noteBody to body of n
  set noteCreated to creation date of n as text
  set noteModified to modification date of n as text
  return noteTitle & "${FIELD_DELIM}" & noteId & "${FIELD_DELIM}" & noteBody & "${FIELD_DELIM}" & noteCreated & "${FIELD_DELIM}" & noteModified
end tell`);
  const [noteTitle, id, body, creationDate, modificationDate] = raw.split(FIELD_DELIM);
  return { title: noteTitle, id, body, creationDate, modificationDate };
}

async function createNote(title: string, body: string, folder: string): Promise<string> {
  const safeTitle = sanitize(title);
  const safeBody = sanitize(body);
  const safeFolder = sanitize(folder);
  return runAppleScript(`
tell application "Notes"
  set theFolder to folder "${safeFolder}"
  make new note at theFolder with properties {name:"${safeTitle}", body:"${safeBody}"}
  return "Note created: ${safeTitle} in ${safeFolder}"
end tell`);
}

async function updateNote(title: string, body: string, folder?: string): Promise<string> {
  const safeTitle = sanitize(title);
  const safeBody = sanitize(body);
  return runAppleScript(`
tell application "Notes"
  set matchedNotes to (${noteScope(folder)} whose name is "${safeTitle}")
  if (count of matchedNotes) is 0 then
    error "Note not found: ${safeTitle}"
  end if
  set n to item 1 of matchedNotes
  set body of n to "${safeBody}"
  return "Note updated: ${safeTitle}"
end tell`);
}

async function deleteNote(title: string, folder?: string): Promise<string> {
  const safeTitle = sanitize(title);
  return runAppleScript(`
tell application "Notes"
  set matchedNotes to (${noteScope(folder)} whose name is "${safeTitle}")
  if (count of matchedNotes) is 0 then
    error "Note not found: ${safeTitle}"
  end if
  delete item 1 of matchedNotes
  return "Note deleted: ${safeTitle}"
end tell`);
}

async function moveNote(title: string, fromFolder: string, toFolder: string): Promise<string> {
  const safeTitle = sanitize(title);
  const safeFrom = sanitize(fromFolder);
  const safeTo = sanitize(toFolder);
  return runAppleScript(`
tell application "Notes"
  set matchedNotes to (notes of folder "${safeFrom}" whose name is "${safeTitle}")
  if (count of matchedNotes) is 0 then
    error "Note not found: ${safeTitle} in folder ${safeFrom}"
  end if
  set n to item 1 of matchedNotes
  move n to folder "${safeTo}"
  return "Note moved: ${safeTitle} from ${safeFrom} to ${safeTo}"
end tell`);
}

async function appendToNote(title: string, content: string, folder?: string): Promise<string> {
  const safeTitle = sanitize(title);
  const safeContent = sanitize(content);
  return runAppleScript(`
tell application "Notes"
  set matchedNotes to (${noteScope(folder)} whose name is "${safeTitle}")
  if (count of matchedNotes) is 0 then
    error "Note not found: ${safeTitle}"
  end if
  set n to item 1 of matchedNotes
  set body of n to (body of n) & "${safeContent}"
  return "Content appended to note: ${safeTitle}"
end tell`);
}

async function searchNotes(query: string, folder?: string): Promise<Array<Record<string, string>>> {
  const safeQuery = sanitize(query);
  let script: string;
  if (folder) {
    const safeFolder = sanitize(folder);
    script = `
tell application "Notes"
  set results to {}
  set matchedNotes to (notes of folder "${safeFolder}" whose name contains "${safeQuery}" or body contains "${safeQuery}")
  repeat with n in matchedNotes
    set noteTitle to name of n
    set noteId to id of n
    set end of results to noteTitle & "${FIELD_DELIM}" & noteId & "${FIELD_DELIM}" & "${safeFolder}"
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`;
  } else {
    script = `
tell application "Notes"
  set results to {}
  repeat with f in folders
    set folderName to name of f
    set matchedNotes to (notes of f whose name contains "${safeQuery}" or body contains "${safeQuery}")
    repeat with n in matchedNotes
      set noteTitle to name of n
      set noteId to id of n
      set end of results to noteTitle & "${FIELD_DELIM}" & noteId & "${FIELD_DELIM}" & folderName
    end repeat
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`;
  }
  const raw = await runAppleScript(script);
  if (!raw) return [];
  return raw.split(RECORD_DELIM).map((record) => {
    const [title, id, folderName] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { title, id, folder: folderName };
  });
}

export function createNotesMcpServer(config: AppleAppConfig): McpServer {
  const mode = config.safetyMode;
  const server = new McpServer({ name: 'apple-notes', version: '1.0.0' }, { capabilities: {} });

  server.registerTool('list_folders', { description: 'List all folders in Apple Notes', inputSchema: {} }, async () => {
    try {
      return textResult(await listFolders());
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  });

  server.registerTool(
    'create_folder',
    {
      description: 'Create a new folder in Apple Notes',
      inputSchema: { name: z.string().describe('Name of the folder to create') },
    },
    async ({ name }) => {
      try {
        return textResult(await createFolder(name));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'list_notes',
    {
      description: 'List all notes in a specified Apple Notes folder',
      inputSchema: { folder: z.string().describe('Name of the folder to list notes from') },
    },
    async ({ folder }) => {
      try {
        return textResult(await listNotes(folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_note',
    {
      description: 'Get the full content of a specific note by title',
      inputSchema: {
        title: z.string().describe('Title of the note to retrieve'),
        folder: z.string().optional().describe('Folder to search in (searches all folders if omitted)'),
      },
    },
    async ({ title, folder }) => {
      try {
        return textResult(await getNote(title, folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'create_note',
    {
      description: 'Create a new note in a specified Apple Notes folder',
      inputSchema: {
        title: z.string().describe('Title of the new note'),
        body: z.string().describe('HTML body content of the note'),
        folder: z.string().describe('Folder to create the note in'),
      },
    },
    async ({ title, body, folder }) => {
      try {
        return textResult(await createNote(title, body, folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'update_note',
    {
      description: 'Update the body of an existing note',
      inputSchema: {
        title: z.string().describe('Title of the note to update'),
        body: z.string().describe('New HTML body content for the note'),
        folder: z.string().optional().describe('Folder the note is in (searches all folders if omitted)'),
      },
    },
    async ({ title, body, folder }) => {
      try {
        return textResult(await updateNote(title, body, folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (!isReadOnly(mode)) {
    server.registerTool(
      'delete_note',
      {
        description: 'Delete a note from Apple Notes',
        inputSchema: {
          title: z.string().describe('Title of the note to delete'),
          folder: z.string().optional().describe('Folder the note is in (searches all folders if omitted)'),
          confirm: confirmArg,
        },
      },
      async ({ title, folder, confirm }) => {
        const gate = confirmGuard(
          mode,
          confirm,
          'This will permanently delete the note. Please confirm with the user, then call again with confirm: true.',
        );
        if (gate) return gate;
        try {
          return textResult(await deleteNote(title, folder));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );

    server.registerTool(
      'delete_folder',
      {
        description: 'Delete a folder and all its notes from Apple Notes',
        inputSchema: {
          name: z.string().describe('Name of the folder to delete'),
          confirm: confirmArg,
        },
      },
      async ({ name, confirm }) => {
        const gate = confirmGuard(
          mode,
          confirm,
          'This will permanently delete the folder and all notes inside it. Please confirm with the user, then call again with confirm: true.',
        );
        if (gate) return gate;
        try {
          return textResult(await deleteFolder(name));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  server.registerTool(
    'move_note',
    {
      description: 'Move a note from one folder to another',
      inputSchema: {
        title: z.string().describe('Title of the note to move'),
        from_folder: z.string().describe('Source folder name'),
        to_folder: z.string().describe('Destination folder name'),
      },
    },
    async ({ title, from_folder, to_folder }) => {
      try {
        return textResult(await moveNote(title, from_folder, to_folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'append_to_note',
    {
      description: 'Append HTML content to an existing note without replacing its body',
      inputSchema: {
        title: z.string().describe('Title of the note to append to'),
        content: z.string().describe('HTML content to append to the note'),
        folder: z.string().optional().describe('Folder the note is in (searches all folders if omitted)'),
      },
    },
    async ({ title, content, folder }) => {
      try {
        return textResult(await appendToNote(title, content, folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'search_notes',
    {
      description:
        'Search notes by keyword across all folders or within a specific folder. Searches both titles and body content.',
      inputSchema: {
        query: z.string().describe('Search keyword to match against note titles and body content'),
        folder: z.string().optional().describe('Folder to search in (searches all folders if omitted)'),
      },
    },
    async ({ query, folder }) => {
      try {
        return textResult(await searchNotes(query, folder));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
