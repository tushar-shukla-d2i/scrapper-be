const { launchBrowser } = require("../playwright/browserLauncher");

exports.startBrowser = async (url) =>{
    await launchBrowser(url);
};