/**
 * In-process Apple Contacts MCP server (AppleScript-backed).
 *
 * Derived from MIT-licensed griches/apple-mcp (`@griches/apple-contacts-mcp` 1.0.0),
 * vendored in-tree by Luna. Raw tool names preserved for the tool-alias map.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';

import { errorResult, textResult } from '../../shared/cli.js';
import { FIELD_DELIM, RECORD_DELIM, runAppleScript, sanitize } from '../shared/applescript.js';
import { confirmArg, confirmGuard, isReadOnly } from '../shared/safety.js';
import type { AppleAppConfig } from '../shared/types.js';

interface ContactOptions {
  email?: string;
  phone?: string;
  organization?: string;
  jobTitle?: string;
  note?: string;
}

async function listGroups(): Promise<Array<{ name: string }>> {
  const raw = await runAppleScript(`
tell application "Contacts"
  set groupList to {}
  repeat with g in groups
    set end of groupList to name of g
  end repeat
  set AppleScript's text item delimiters to "${FIELD_DELIM}"
  return groupList as text
end tell`);
  if (!raw) return [];
  return raw.split(FIELD_DELIM).map((name) => ({ name: name.trim() }));
}

async function createGroup(name: string): Promise<string> {
  const safeName = sanitize(name);
  return runAppleScript(`
tell application "Contacts"
  make new group with properties {name:"${safeName}"}
  save
  return "Group created: ${safeName}"
end tell`);
}

async function listContacts(group?: string): Promise<Array<{ name: string; id: string }>> {
  const scope = group ? `people of group "${sanitize(group)}"` : 'people';
  const raw = await runAppleScript(`
tell application "Contacts"
  set contactList to {}
  repeat with p in ${scope}
    set contactName to name of p
    set contactId to id of p
    set end of contactList to contactName & "${FIELD_DELIM}" & contactId
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return contactList as text
end tell`);
  if (!raw) return [];
  return raw.split(RECORD_DELIM).map((record) => {
    const [name, id] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { name, id };
  });
}

async function getContact(name: string): Promise<Record<string, unknown>> {
  const safeName = sanitize(name);
  const raw = await runAppleScript(`
tell application "Contacts"
  set matchedPeople to (every person whose name is "${safeName}")
  if (count of matchedPeople) is 0 then
    error "Contact not found: ${safeName}"
  end if
  set p to item 1 of matchedPeople
  set contactName to name of p
  set contactId to id of p

  set emailList to {}
  repeat with e in emails of p
    set end of emailList to value of e
  end repeat
  set AppleScript's text item delimiters to ","
  set emailStr to emailList as text

  set phoneList to {}
  repeat with ph in phones of p
    set end of phoneList to value of ph
  end repeat
  set phoneStr to phoneList as text

  set orgStr to ""
  try
    set orgStr to organization of p
  end try

  set titleStr to ""
  try
    set titleStr to job title of p
  end try

  set noteStr to ""
  try
    set noteStr to note of p
  end try

  set addrList to {}
  repeat with a in addresses of p
    set addrParts to {}
    try
      set end of addrParts to street of a
    end try
    try
      set end of addrParts to city of a
    end try
    try
      set end of addrParts to state of a
    end try
    try
      set end of addrParts to zip of a
    end try
    try
      set end of addrParts to country of a
    end try
    set AppleScript's text item delimiters to ", "
    set end of addrList to addrParts as text
  end repeat
  set AppleScript's text item delimiters to "${FIELD_DELIM}"
  set addrStr to addrList as text

  return contactName & "${RECORD_DELIM}" & contactId & "${RECORD_DELIM}" & emailStr & "${RECORD_DELIM}" & phoneStr & "${RECORD_DELIM}" & orgStr & "${RECORD_DELIM}" & titleStr & "${RECORD_DELIM}" & noteStr & "${RECORD_DELIM}" & addrStr
end tell`);
  const parts = raw.split(RECORD_DELIM);
  return {
    name: parts[0]?.trim() || '',
    id: parts[1]?.trim() || '',
    emails: parts[2]
      ? parts[2]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    phones: parts[3]
      ? parts[3]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
    organization: parts[4]?.trim() || null,
    jobTitle: parts[5]?.trim() || null,
    note: parts[6]?.trim() || null,
    addresses: parts[7]
      ? parts[7]
          .split(FIELD_DELIM)
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  };
}

async function searchContacts(query: string): Promise<Array<{ name: string; id: string }>> {
  const safeQuery = sanitize(query);
  const raw = await runAppleScript(`
tell application "Contacts"
  set results to {}
  set matchedPeople to (every person whose name contains "${safeQuery}")
  repeat with p in matchedPeople
    set contactName to name of p
    set contactId to id of p
    set end of results to contactName & "${FIELD_DELIM}" & contactId
  end repeat
  set AppleScript's text item delimiters to "${RECORD_DELIM}"
  return results as text
end tell`);
  if (!raw) return [];
  return raw.split(RECORD_DELIM).map((record) => {
    const [name, id] = record.split(FIELD_DELIM).map((s) => s.trim());
    return { name, id };
  });
}

async function createContact(firstName: string, lastName: string, options?: ContactOptions): Promise<string> {
  const safeFirst = sanitize(firstName);
  const safeLast = sanitize(lastName);
  let props = `{first name:"${safeFirst}", last name:"${safeLast}"`;
  if (options?.organization) props += `, organization:"${sanitize(options.organization)}"`;
  if (options?.jobTitle) props += `, job title:"${sanitize(options.jobTitle)}"`;
  if (options?.note) props += `, note:"${sanitize(options.note)}"`;
  props += '}';
  let extras = '';
  if (options?.email) {
    extras += `\n  make new email at end of emails of newPerson with properties {label:"work", value:"${sanitize(options.email)}"}`;
  }
  if (options?.phone) {
    extras += `\n  make new phone at end of phones of newPerson with properties {label:"mobile", value:"${sanitize(options.phone)}"}`;
  }
  return runAppleScript(`
tell application "Contacts"
  set newPerson to make new person with properties ${props}${extras}
  save
  return "Contact created: ${safeFirst} ${safeLast}"
end tell`);
}

async function updateContact(
  name: string,
  updates: ContactOptions & { firstName?: string; lastName?: string },
): Promise<string> {
  const safeName = sanitize(name);
  let setStatements = '';
  if (updates.firstName) setStatements += `\n  set first name of p to "${sanitize(updates.firstName)}"`;
  if (updates.lastName) setStatements += `\n  set last name of p to "${sanitize(updates.lastName)}"`;
  if (updates.organization) setStatements += `\n  set organization of p to "${sanitize(updates.organization)}"`;
  if (updates.jobTitle) setStatements += `\n  set job title of p to "${sanitize(updates.jobTitle)}"`;
  if (updates.note) setStatements += `\n  set note of p to "${sanitize(updates.note)}"`;
  if (updates.email) {
    setStatements += `\n  make new email at end of emails of p with properties {label:"work", value:"${sanitize(updates.email)}"}`;
  }
  if (updates.phone) {
    setStatements += `\n  make new phone at end of phones of p with properties {label:"mobile", value:"${sanitize(updates.phone)}"}`;
  }
  return runAppleScript(`
tell application "Contacts"
  set matchedPeople to (every person whose name is "${safeName}")
  if (count of matchedPeople) is 0 then
    error "Contact not found: ${safeName}"
  end if
  set p to item 1 of matchedPeople${setStatements}
  save
  return "Contact updated: ${safeName}"
end tell`);
}

async function removeContactFromGroup(contactName: string, groupName: string): Promise<string> {
  const safeName = sanitize(contactName);
  const safeGroup = sanitize(groupName);
  return runAppleScript(`
tell application "Contacts"
  set matchedPeople to (every person whose name is "${safeName}")
  if (count of matchedPeople) is 0 then
    error "Contact not found: ${safeName}"
  end if
  set p to item 1 of matchedPeople
  set g to group "${safeGroup}"
  remove p from g
  save
  return "Removed ${safeName} from group ${safeGroup}"
end tell`);
}

async function deleteGroup(name: string): Promise<string> {
  const safeName = sanitize(name);
  return runAppleScript(`
tell application "Contacts"
  set matchedGroups to (every group whose name is "${safeName}")
  if (count of matchedGroups) is 0 then
    error "Group not found: ${safeName}"
  end if
  delete item 1 of matchedGroups
  save
  return "Group deleted: ${safeName}"
end tell`);
}

async function deleteContact(name: string): Promise<string> {
  const safeName = sanitize(name);
  return runAppleScript(`
tell application "Contacts"
  set matchedPeople to (every person whose name is "${safeName}")
  if (count of matchedPeople) is 0 then
    error "Contact not found: ${safeName}"
  end if
  delete item 1 of matchedPeople
  save
  return "Contact deleted: ${safeName}"
end tell`);
}

async function addContactToGroup(contactName: string, groupName: string): Promise<string> {
  const safeName = sanitize(contactName);
  const safeGroup = sanitize(groupName);
  return runAppleScript(`
tell application "Contacts"
  set matchedPeople to (every person whose name is "${safeName}")
  if (count of matchedPeople) is 0 then
    error "Contact not found: ${safeName}"
  end if
  set p to item 1 of matchedPeople
  set g to group "${safeGroup}"
  add p to g
  save
  return "Added ${safeName} to group ${safeGroup}"
end tell`);
}

export function createContactsMcpServer(config: AppleAppConfig): McpServer {
  const mode = config.safetyMode;
  const server = new McpServer({ name: 'apple-contacts', version: '1.0.0' }, { capabilities: {} });

  server.registerTool(
    'list_groups',
    { description: 'List all groups in Apple Contacts', inputSchema: {} },
    async () => {
      try {
        return textResult(await listGroups());
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'list_contacts',
    {
      description: 'List all contacts, optionally filtered by group',
      inputSchema: {
        group: z.string().optional().describe('Group name to filter contacts (lists all if omitted)'),
      },
    },
    async ({ group }) => {
      try {
        return textResult(await listContacts(group));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'get_contact',
    {
      description: 'Get full details of a contact by name including emails, phones, organization, and addresses',
      inputSchema: { name: z.string().describe('Full name of the contact to retrieve') },
    },
    async ({ name }) => {
      try {
        return textResult(await getContact(name));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'search_contacts',
    {
      description: 'Search contacts by name',
      inputSchema: { query: z.string().describe('Text to search for in contact names') },
    },
    async ({ query }) => {
      try {
        return textResult(await searchContacts(query));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'update_contact',
    {
      description:
        "Update an existing contact's details. For email and phone, new entries are added (existing ones are not removed).",
      inputSchema: {
        name: z.string().describe('Full name of the contact to update'),
        first_name: z.string().optional().describe('New first name'),
        last_name: z.string().optional().describe('New last name'),
        email: z.string().optional().describe('Email address to add'),
        phone: z.string().optional().describe('Phone number to add'),
        organization: z.string().optional().describe('New company or organization'),
        job_title: z.string().optional().describe('New job title'),
        note: z.string().optional().describe('New note'),
      },
    },
    async ({ name, first_name, last_name, email, phone, organization, job_title, note }) => {
      try {
        return textResult(
          await updateContact(name, {
            firstName: first_name,
            lastName: last_name,
            email,
            phone,
            organization,
            jobTitle: job_title,
            note,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'create_contact',
    {
      description: 'Create a new contact in Apple Contacts',
      inputSchema: {
        first_name: z.string().describe('First name of the contact'),
        last_name: z.string().describe('Last name of the contact'),
        email: z.string().optional().describe('Email address'),
        phone: z.string().optional().describe('Phone number'),
        organization: z.string().optional().describe('Company or organization'),
        job_title: z.string().optional().describe('Job title'),
        note: z.string().optional().describe('Note about the contact'),
      },
    },
    async ({ first_name, last_name, email, phone, organization, job_title, note }) => {
      try {
        return textResult(
          await createContact(first_name, last_name, {
            email,
            phone,
            organization,
            jobTitle: job_title,
            note,
          }),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (!isReadOnly(mode)) {
    server.registerTool(
      'delete_contact',
      {
        description: 'Delete a contact by name',
        inputSchema: {
          name: z.string().describe('Full name of the contact to delete'),
          confirm: confirmArg,
        },
      },
      async ({ name, confirm }) => {
        const gate = confirmGuard(
          mode,
          confirm,
          'This will permanently delete the contact. Please confirm with the user, then call again with confirm: true.',
        );
        if (gate) return gate;
        try {
          return textResult(await deleteContact(name));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  server.registerTool(
    'create_group',
    {
      description: 'Create a new group in Apple Contacts',
      inputSchema: { name: z.string().describe('Name of the group to create') },
    },
    async ({ name }) => {
      try {
        return textResult(await createGroup(name));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'add_contact_to_group',
    {
      description: 'Add an existing contact to a group',
      inputSchema: {
        contact_name: z.string().describe('Full name of the contact'),
        group_name: z.string().describe('Name of the group to add the contact to'),
      },
    },
    async ({ contact_name, group_name }) => {
      try {
        return textResult(await addContactToGroup(contact_name, group_name));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'remove_contact_from_group',
    {
      description: 'Remove a contact from a group',
      inputSchema: {
        contact_name: z.string().describe('Full name of the contact'),
        group_name: z.string().describe('Name of the group to remove the contact from'),
      },
    },
    async ({ contact_name, group_name }) => {
      try {
        return textResult(await removeContactFromGroup(contact_name, group_name));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  if (!isReadOnly(mode)) {
    server.registerTool(
      'delete_group',
      {
        description: 'Delete a contact group',
        inputSchema: {
          name: z.string().describe('Name of the group to delete'),
          confirm: confirmArg,
        },
      },
      async ({ name, confirm }) => {
        const gate = confirmGuard(
          mode,
          confirm,
          'This will permanently delete the contact group. Please confirm with the user, then call again with confirm: true.',
        );
        if (gate) return gate;
        try {
          return textResult(await deleteGroup(name));
        } catch (err) {
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }

  return server;
}
