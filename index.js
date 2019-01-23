const { spawn } = require("child_process");
const path = require("path");
const fetch = require("node-fetch");
const child = spawn(
  path.resolve(__dirname, "node_modules/.bin/elm-analyse"),
  ["-s", "-p 3002"],
  { cwd: "/home/ec2-user/environment/git/apptest" }
);

let result = "";
child.stdout.on("data", function(data) {
  result += data.toString();
  console.log("Result", result);
});

child.on("exit", function(code, signal) {
  console.log(
    "child process exited with " + `code ${code} and signal ${signal}`
  );
});

setInterval(() => {
  fetch("http://localhost:3002/human-state")
    .then(res => res.text())
    .then(body => console.log("Got it", body))
    .catch(err => console.log("Uh oh, errored", err));
}, 5000);
