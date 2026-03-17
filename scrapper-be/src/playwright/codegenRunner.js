const { spawn } = require('child_process');

function runCodegen(url) {
    return new Promise((resolve, reject) => {

        const process = spawn('npx', ['playwright', 'codegen', url], {
            stdio: 'inherit',
            shell: true
        });

        process.on('close', (code) => {
            console.log(`codegen exited with ${code}`);
            resolve();
        });

        process.on('error', (err) => {
            reject(err);
        });

    });
}

module.exports = {
    runCodegen
};