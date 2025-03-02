const fsPromises = require("fs/promises");
const { google } = require("googleapis");
const core = require("@actions/core");

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
  const exportedFiles = await exportFiles({ files, auth });
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
    
    // If it's the root, reverse and trim the trailing slash
    if (id === rootFolderId) {
      const trimmedPath = currentPath.trim('/').split('/').reverse().join('/').trim('/');
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
    .then(response => response.body)
    .then(async body => {
      let text = await new Response(body).text();
      return text;
    });
}

async function exportFiles({ files, auth }) {
  return Promise.all(
    files.map(async (file) => {
      console.log("Exporting", file.name);
      try {
        const content = await getFileContentsAsMarkdown(file.id, auth);
        return {
          ...file,
          content,
        };
      } catch (err) {
        console.log("Could not export", file.name);
        console.log(err);
        return {
          ...file,
          content: ""
        }
      }
    })
  );
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

async function listFiles({ drive, googleDriveFolderId, googleDriveQuery }) {
  const query = `'${googleDriveFolderId}' in parents`;
  const response = await drive.files.list({
    fields: "nextPageToken, files(id, name, fileExtension, createdTime, modifiedTime, mimeType, parents)",
    orderBy: "modifiedTime desc",
    pageSize: 1000,
    q: googleDriveQuery ? `${query} and ((mimeType = 'application/vnd.google-apps.folder') or (${googleDriveQuery}))` : query
  });
  return response.data.files;
}

async function writeExportedFiles({ exportedFiles, directories, recursive, googleDriveFolderId }) {
  exportedFiles.forEach(async (exportedFile) => {

    // if we're not keeping the folder structure, dump everything in the top level output folder
    const parentFolderId = recursive ? exportedFile.parents[0] : googleDriveFolderId;

    // remove the file extension from the name of the file if applicable.  google docs have no file extension
    let fileName = exportedFile.name;
    if( exportedFile.fileExtension ) {
      fileName = fileName.replace(`.${exportedFile.fileExtension}`, ``);
    }
    const filePath = `${directories[parentFolderId]}/${fileName}.md`
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
