require("dotenv").config({ quiet: true });
require("../services/adminStore")
  .adminStore.restrictions()
  .then(() => {
    console.log("Admin SQL schema ready.");
    return require("../config/db").closeAllPools();
  })
  .catch(async () => {
    console.error(
      "Admin schema setup failed. Check control tenant configuration and SQL CREATE TABLE permissions.",
    );
    await require("../config/db").closeAllPools();
    process.exitCode = 1;
  });
