const fsPromises = require("fs/promises");
const { google } = require("googleapis");
const core = require("@actions/core");
const dateFns = require("date-fns");

async function main({ googleDriveFolderId, outputDirectoryPath, googleDriveQuery, recursive }) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/documents"],
  });
  const drive = google.drive({
    auth: auth,
    version: "v3",
  });

  let folders = [{name: outputDirectoryPath, id: googleDriveFolderId}];
  if( !!recursive ) {
    let asyncFolderGenerator = await listFilesRecursive({ drive, googleDriveFolderId, googleDriveQuery: `mimeType = 'application/vnd.google-apps.folder'`});
    for await (const folder of asyncFolderGenerator) {
      folders.push(folder);
    }
  }
  console.log("Folders:", folders);

  let files = [];
  if( !!recursive ) {
    let asyncFilesGenerator = await listFilesRecursive({ drive, googleDriveFolderId, googleDriveQuery });
    for await (const file of asyncFilesGenerator) {
      if( file.mimeType !== 'application/vnd.google-apps.folder') {
        files.push(file);
      }
    }
  } else {
    // files = await listFiles({ drive, googleDriveFolderId, googleDriveQuery });
  }
  console.log("Files:", files);

  // create output folder structure
  const directories = getFolderPaths({folders, rootPath: outputDirectoryPath, rootFolderId: googleDriveFolderId});
  console.log("Directories", directories);
  for (const directory of Object.values(directories)) {
    await createDirectory({ outputDirectoryPath: directory });
  }

  // write files to the path of their parent if applicable
  const exportedFiles = await exportFiles({ drive, files, auth });
  await writeExportedFiles({ exportedFiles, directories, recursive, googleDriveFolderId });
}

function getFolderPaths({folders, rootPath, rootFolderId}) {
  // Create a map from id to folder for quick look-up
  const folderMap = new Map();
  folders.forEach(folder => {
      folderMap.set(folder.id, folder);
  });

  // Filter out the root folder and process each non-root folder
  const paths = {};
  const nonRootFolders = folders.filter(f => f.id !== rootFolderId);
  
  function buildPath(id, currentPath = '') {
    // Get the current folder from the map
    const folder = folderMap.get(id);
    if (!folder) return '';
    
    // Add the current folder's name to the path
    currentPath += folder.name + '/';
    
    // If it's the root, reverse and slice the beginning slash
    if (id === rootFolderId) {
      const trimmedPath = currentPath.split('/').reverse().join('/').trim().slice(1);
      return trimmedPath;
    }
    
    // Recursively build the path towards the root
    return buildPath(folder.parents[0], currentPath);
  }
  
  paths[rootFolderId] = rootPath;
  nonRootFolders.forEach(folder => {
    const path = buildPath(folder.id, '');
    paths[folder.id] = path;
  });
  
  return paths;
}

async function createDirectory({ outputDirectoryPath }) {
  await fsPromises.stat(outputDirectoryPath).catch((err) => {
    if (err.code === "ENOENT") {
      console.log("Output directory does not exist.  Creating...")
      return fsPromises.mkdir(outputDirectoryPath, { recursive: true }).then(() => {
        console.log("Created output directory", outputDirectoryPath)
      });
    }
  });
}

async function getFileContentsAsMarkdown(fileId, auth) {
  const request = await auth.authorizeRequest({
    url: `https://docs.google.com/feeds/download/documents/export/Export?id=${fileId}&exportFormat=markdown`
  });
  return await fetch(request.url, {headers: request.headers})
    .then(async response => {
      if (response.ok) {
        let text = await new Response(response.body).text();
        return text;
      }
      console.error(`${response.status}: ${response.statusText}`)
      throw new Error(`Google could not export this file as Markdown.`);
    });
}

function getFileContents({ drive, fileId }) {
  return drive.files.get({
      fileId,
      alt: 'media'
    })    
    .then(response => response.data);
}

/*
* Removes the slug from a block of front matter. Useful for Google drive shortcuts that result in duplicate
* files in multiple places in the docs tree.
*/
function removeSlug(markdownString) {
  let fileContents = markdownString;
  const frontMatterPattern = /(---.*?---[ \t]*\n?)(\n*import.*?\n)*\n*/s; // select the first front matter block, import statements, and whitespace thereafter
  const frontMatterBlocks = fileContents.match(frontMatterPattern);
  
  if( frontMatterBlocks ) {
    // remove the slug line
    const slugPattern = /slug:.*(\r\n|\n|\r)/gm; // select the slug line inside the front matter
    let frontMatterBlockFormatted = frontMatterBlocks[0].replace(slugPattern, ``);
    fileContents = fileContents.replace(frontMatterBlocks[0], frontMatterBlockFormatted);
  } 
  return fileContents;
}

/*
* Adds a head tag to the markdown to exclude a file from the search results.  Useful for Google drive shortcuts that result in duplicate
* files in multiple places in the docs tree.
*
* See https://docusaurus.io/docs/markdown-features/head-metadata#customizing-head-metadata 
*/
function addNoIndexHeadTag(markdownString) {
  let fileContents = markdownString;
  const noIndexTag = `<head><meta name="robots" content="noindex" /></head>\n\n`;
  const pattern = /(---.*?---[ \t]*\n?)(\n*import.*?\n)*\n*/s; // select the first front matter block, import statements, and whitespace thereafter
  const frontMatterBlocks = fileContents.match(pattern);

  if( frontMatterBlocks ) {
    // insert the head tag after the first front matter block and import statements
    let frontMatterBlockFormatted = frontMatterBlocks[0]
      .concat(noIndexTag);
    fileContents = fileContents.replace(frontMatterBlocks[0], frontMatterBlockFormatted);
  } else {
    // insert the head tag at the beginning of the file
    fileContents = noIndexTag.concat(markdownString);
  }
  return fileContents;
}

async function exportFiles({ drive, files, auth }) {
  const results = [];

  for await (const file of files) {
    const modifiedTime = Date.parse(file.modifiedTime);
    const viewedByMeTime = Date.parse(file.viewedByMeTime);
    console.log(`Exporting ${file.name} (${file.id}) [${file.mimeType}] ${modifiedTime > viewedByMeTime ? "[Recently updated!]" : ""}`);
    let content = "";
    try {
      if( file.mimeType !== "application/vnd.google-apps.document" 
          && file.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document" 
          && file.mimeType !== "application/vnd.google-apps.shortcut"
          && file.mimeType !== "application/vnd.google-apps.drive-sdk"
          && file.mimeType !== "application/json") {
        // if it isn't a document type we're interested in, set content to empty so it gets skipped
        content = "";
      }
      else if ( file.name.startsWith(`~`)) {
        // skip any temporary files from word docs being edited
        content = "";
      }
      else if (file.mimeType === "application/vnd.google-apps.shortcut" || file.mimeType === "application/vnd.google-apps.drive-sdk") {
        // for shortcuts, export the data from the original file and set the mimeType to the original
        if(file.shortcutDetails.targetMimeType === "application/vnd.google-apps.document" || file.shortcutDetails.targetMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          content = await getFileContentsAsMarkdown(file.shortcutDetails.targetId, auth);
          content = unescapeBlocks(content);
          content = formatFrontMatter(file, content);
          content = removeSlug(content);
          content = addNoIndexHeadTag(content);
          file.mimeType = file.shortcutDetails.targetMimeType;
        } else {
          content = "";
        }
      }
      else {
        // do the export
        if( file.mimeType === "application/json") {
          // we want the raw content for any json file
          const json = await getFileContents({drive, fileId: file.id});
          content = JSON.stringify(json, null, 2);
        } else {
          // any other type, word docs and google docs can be exported as markdown
          content = await getFileContentsAsMarkdown(file.id, auth);
          content = unescapeBlocks(content);
          content = formatFrontMatter(file, content);
        }
      }
    } catch (err) {
      console.log("Could not export", file.name);
      console.log(err);
    } finally {
      results.push({
        ...file,
        content
      });
    }
  }
  
  return Promise.resolve(results);
}

async function* listFilesRecursive({ drive, googleDriveFolderId, googleDriveQuery }) {
  const files = await listFiles({ drive, googleDriveFolderId, googleDriveQuery });
  for (const file of files) {
    yield file;
    if( file.mimeType === "application/vnd.google-apps.folder") {
      yield* await listFilesRecursive({ drive, googleDriveFolderId: file.id, googleDriveQuery });
    }
  }
}

/*
* Fields available here: https://developers.google.com/workspace/drive/api/reference/rest/v3/files#File
*/
async function listFiles({ drive, googleDriveFolderId, googleDriveQuery }) {
  const query = `'${googleDriveFolderId}' in parents`;
  const response = await drive.files.list({
    fields: "nextPageToken, files(id, name, createdTime, modifiedTime, viewedByMeTime, mimeType, parents, shortcutDetails, lastModifyingUser)",
    orderBy: "modifiedTime desc",
    pageSize: 1000,
    q: googleDriveQuery ? `${query} and ((mimeType = 'application/vnd.google-apps.folder') or (${googleDriveQuery}))` : query
  });
  return response.data.files;
}

/*
* Google Docs supports a limited version of Markdown and inserts \ to escape special characters.  We want to be able to define
* a block inside our Google Doc where Markdown can be post-processed to remove Google's escape characters so that we can use things
* like React components and multiline code blocks with ```
*/
function unescapeBlocks(fileContentString) {
  let fileContents = fileContentString;
  const pattern = /\$\$\$.*?\$\$\$[ \t]*\n?/gs; // match all unescape blocks surrounded by $$$
  const unescapeBlocks = fileContents.match(pattern);
  if( unescapeBlocks ) {
    for (let block of unescapeBlocks) {
      let unescapedBlock = block
        .replace(/^\$\$\$.*?$\n?/gm, ``) // remove any line that starts with $$$ first
        .replace(/\\/g, ``) // remove all the escaping \ that google has inserted
        .replace(/’/g, `'`) // replace backwards single quotes that will throw webpack/mdx compiler errors
        .replace(/”/g, `"`) // replace backwards single quotes that will throw webpack/mdx compiler errors
        .replace(/[ \t]*$/gm, ``); // remove the horizontal whitespace that google has inserted at the end of each line
      fileContents = fileContents.replace(block, unescapedBlock);
      // console.log(unescapedBlock);
    }
  }
  return fileContents;
}

/*
* If there's no front matter block, create one
* If there's a front matter block in the document, discard everything before it
* Insert the Google Doc Id into the front matter block so our "Edit this page" links work correctly
*/
function formatFrontMatter(fileObject, fileContentString) {
  let fileContents = fileContentString;
  const pattern = /---.*?---[ \t]*\n?/s; // select the first front matter block
  const frontMatterBlocks = fileContents.match(pattern);
  const fileModifiedDate = dateFns.parseJSON(fileObject.modifiedTime);
  const frontMatterPropsToAdd = `google_docs_id: ${fileObject.id}\nparent_folder_id: ${fileObject.parents[0]}\ncustom_edit_url: https://docs.google.com/document/d/${fileObject.id}/edit\ncustom_folder_url: https://drive.google.com/drive/folders/${fileObject.parents[0]}\nlast_update:\n  date: ${dateFns.formatRelative(fileModifiedDate, new Date())}\n  author: ${fileObject.lastModifyingUser.emailAddress}`;
  if( frontMatterBlocks ) {
    let frontMatterIndex = fileContents.indexOf(frontMatterBlocks[0]);
    // if the first front matter block is not at the top of the file, discard any content before it
    if( frontMatterIndex > 0 ) {
      console.log(`Front matter not at head of file in ${fileObject.id}`);
      fileContents = fileContents.slice(frontMatterIndex);
    }
    // insert our props into the first existing block
    let frontMatterBlockFormatted = frontMatterBlocks[0]
      .replace(/^---[ \t]*\n/sm, `---\n${frontMatterPropsToAdd}\n`); // replace the opening --- line of the block
    fileContents = fileContents.replace(frontMatterBlocks[0], frontMatterBlockFormatted);
  } else {
    // create a new block at the beginning of the file and insert our props
    fileContents = `---\n${frontMatterPropsToAdd}\n---\n` + fileContentString; // if there's no existing block, add one
  }
  return fileContents;
}

async function writeExportedFiles({ exportedFiles, directories, recursive, googleDriveFolderId }) {
  exportedFiles.forEach(async (exportedFile) => {

    // if we're not keeping the folder structure, dump everything in the top level output folder
    const parentFolderId = recursive ? exportedFile.parents[0] : googleDriveFolderId;

    // remove the file extension from the name of the file if applicable.  google docs have no file extension
    let fileName = exportedFile.name;
    if( exportedFile.mimeType === "application/vnd.google-apps.document" ) {
      fileName = `${fileName}.md`;
    }
    else if (exportedFile.mimeType === "application/json") {
      // don't change the file name
    }
    else {
      fileName = fileName.split('.').slice(0, -1).join('.');
      fileName = `${fileName}.md`;
    }
    const filePath = `${directories[parentFolderId]}/${fileName}`
    if( exportedFile.content !== "") {
      await fsPromises.writeFile(
        filePath,
        exportedFile.content
      );
      console.log("Wrote", filePath);
    } else {
      console.log("Skipped empty file", filePath)
    }
  });
}

main({
  googleDriveFolderId: core.getInput("google_drive_folder_id"),
  outputDirectoryPath: core.getInput("output_directory_path"),
  googleDriveQuery: core.getInput("google_drive_query"),
  recursive: core.getInput("recursive"),
}).catch(core.setFailed);
