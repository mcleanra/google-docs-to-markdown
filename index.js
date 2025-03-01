const fsPromises = require("fs/promises");
const { google } = require("googleapis");
const core = require("@actions/core");

async function main({ googleDriveFolderId, outputDirectoryPath, googleDriveQuery }) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/documents"],
  });
  const drive = google.drive({
    auth: auth,
    version: "v3",
  });
  const files = await listFiles({ drive, googleDriveFolderId, googleDriveQuery });
  console.log("Files:", files);

  await createDirectory({ outputDirectoryPath });

  const exportedFiles = await exportFiles({
    files,
    auth
  });

  await writeExportedFiles({ exportedFiles, outputDirectoryPath });
}

async function createDirectory({ outputDirectoryPath }) {
  await fsPromises.stat(outputDirectoryPath).catch((err) => {
    if (err.code === "ENOENT") {
      console.log("Output directory does not exist.  Creating...")
      return fsPromises.mkdir(outputDirectoryPath, { recursive: true }).then(() => {
        console.log("Created output directory")
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

async function listFiles({ drive, googleDriveFolderId, googleDriveQuery }) {
  const query = `'${googleDriveFolderId}' in parents`;
  const response = await drive.files.list({
    fields: "nextPageToken, files(id, name, createdTime, modifiedTime, mimeType)",
    orderBy: "modifiedTime desc",
    pageSize: 1000,
    q: googleDriveQuery ? `${query} and ${googleDriveQuery}` : query
  });
  return response.data.files;
}

async function writeExportedFiles({ exportedFiles, outputDirectoryPath }) {
  exportedFiles.forEach(async (exportedFile) => {
    const file = `${outputDirectoryPath}/${exportedFile.name}.md`
    if( exportedFile.content !== "") {
      await fsPromises.writeFile(
        file,
        exportedFile.content
      );
      console.log("Wrote", file);
    } else {
      console.log("Skipped empty file", file)
    }
  });
}

main({
  googleDriveFolderId: core.getInput("google_drive_folder_id"),
  outputDirectoryPath: core.getInput("output_directory_path"),
  googleDriveQuery: core.getInput("google_drive_query"),
}).catch(core.setFailed);
