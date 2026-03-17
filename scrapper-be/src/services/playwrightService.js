const { runCodegen } = require('../playwright/codegenRunner');

exports.startCodegen = async (url) =>{
    return runCodegen(url);
};