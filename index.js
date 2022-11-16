const path = require('path');
const core = require('@actions/core');
const aws = require('aws-sdk');
const yaml = require('yaml');
const fs = require('fs');

// Attributes that are returned by DescribeTaskDefinition, but are not valid RegisterTaskDefinition inputs
const IGNORED_TASK_DEFINITION_ATTRIBUTES = [
  'compatibilities',
  'taskDefinitionArn',
  'requiresAttributes',
  'revision',
  'status',
  'registeredAt',
  'deregisteredAt',
  'registeredBy',
  'runtimePlatform'
];

const WAIT_DEFAULT_DELAY_SEC = 5;
const MAX_WAIT_MINUTES = 360;

function isEmptyValue(value) {
  if (value === null || value === undefined || value === '') {
    return true;
  }

  if (Array.isArray(value)) {
    for (var element of value) {
      if (!isEmptyValue(element)) {
        // the array has at least one non-empty element
        return false;
      }
    }
    // the array has no non-empty elements
    return true;
  }

  if (typeof value === 'object') {
    for (var childValue of Object.values(value)) {
      if (!isEmptyValue(childValue)) {
        // the object has at least one non-empty property
        return false;
      }
    }
    // the object has no non-empty property
    return true;
  }

  return false;
}

function emptyValueReplacer(_, value) {
  if (isEmptyValue(value)) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.filter(e => !isEmptyValue(e));
  }

  return value;
}

function cleanNullKeys(obj) {
  return JSON.parse(JSON.stringify(obj, emptyValueReplacer));
}

function removeIgnoredAttributes(taskDef) {
  for (var attribute of IGNORED_TASK_DEFINITION_ATTRIBUTES) {
    if (taskDef[attribute]) {
      delete taskDef[attribute];
    }
  }

  return taskDef;
}

async function run() {
  try {
    const agent = 'amazon-ecs-run-task-for-github-actions'

    const ecs = new aws.ECS({
      customUserAgent: agent
    });

    // Get inputs
    const taskDefinitionFile = core.getInput('task-definition', { required: true });
    const containerName = core.getInput('container-name', { required: true });
    const cluster = core.getInput('cluster', { required: false });
    const count = core.getInput('count', { required: true });
    const subnets = (core.getInput('subnets', { required: true }) || "").split(",");
    const containerSecurityGroup = core.getInput('container-security-group', { required: true });
    const entryPoint = core.getInput('entry-point', { required: false });
    const startedBy = core.getInput('started-by', { required: false }) || agent;
    const waitForFinish = core.getInput('wait-for-finish', { required: false }) || false;
    let waitForMinutes = parseInt(core.getInput('wait-for-minutes', { required: false })) || 30;
    if (waitForMinutes > MAX_WAIT_MINUTES) {
      waitForMinutes = MAX_WAIT_MINUTES;
    }

    // Register the task definition
    core.debug('Registering the task definition');
    const taskDefPath = path.isAbsolute(taskDefinitionFile) ?
      taskDefinitionFile :
      path.join(process.env.GITHUB_WORKSPACE, taskDefinitionFile);
    const fileContents = fs.readFileSync(taskDefPath, 'utf8');
    const taskDefContents = removeIgnoredAttributes(cleanNullKeys(yaml.parse(fileContents)));

    if (entryPoint) {
      // use a new family name for this task definition so we don't overwrite the original task definition
      const entryPointSlug = entryPoint.replace(/[^a-zA-Z0-9-]/g, "-").replace(/[-]+/g, "-");
      // a simple 8 digit hex hash - https://stackoverflow.com/questions/7616461/generate-a-hash-from-string-in-javascript
      const entryPointCode = entryPoint.split('').reduce((a,b) => (((a << 5) - a) + b.charCodeAt(0))|0, 0).toString(16);
      taskDefContents.family = taskDefContents.family + "--" + entryPointCode + "-" + entryPointSlug;
      taskDefContents.containerDefinitions[0].entryPoint = entryPoint.split(" ");
    }

    let registerResponse;
    try {
      registerResponse = await ecs.registerTaskDefinition(taskDefContents).promise();
    } catch (error) {
      core.setFailed("Failed to register task definition in ECS: " + error.message);
      core.debug("Task definition contents:");
      core.debug(JSON.stringify(taskDefContents, undefined, 4));
      throw(error);
    }
    const taskDefArn = registerResponse.taskDefinition.taskDefinitionArn;
    core.setOutput('task-definition-arn', taskDefArn);

    const clusterName = cluster ? cluster : 'default';

    core.debug(`Running task with ${JSON.stringify({
      cluster: clusterName,
      taskDefinition: taskDefArn,
      count: count,
      startedBy: startedBy
    })}`)

    const runTaskResponse = await ecs.runTask({
      cluster: clusterName,
      taskDefinition: taskDefArn,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: subnets,
          assignPublicIp: 'DISABLED',
          securityGroups: [containerSecurityGroup]
        }
      },
      launchType: "FARGATE",
      count: count,
      startedBy: startedBy
    }).promise();

    core.debug(`Run task response ${JSON.stringify(runTaskResponse)}`)

    if (runTaskResponse.failures && runTaskResponse.failures.length > 0) {
      const failure = runTaskResponse.failures[0];
      throw new Error(`${failure.arn} is ${failure.reason}`);
    }

    const taskArns = runTaskResponse.tasks.map(task => task.taskArn);

    core.setOutput('task-arn', taskArns);

    if (waitForFinish && waitForFinish.toLowerCase() === 'true') {
      await waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes);
      await tasksExitCode(ecs, clusterName, taskArns);
    }
  }
  catch (error) {
    core.setFailed(error.message);
    core.debug(error.stack);
  }
}

async function waitForTasksStopped(ecs, clusterName, taskArns, waitForMinutes) {
  if (waitForMinutes > MAX_WAIT_MINUTES) {
    waitForMinutes = MAX_WAIT_MINUTES;
  }

  const maxAttempts = (waitForMinutes * 60) / WAIT_DEFAULT_DELAY_SEC;

  core.debug('Waiting for tasks to stop');
  
  const waitTaskResponse = await ecs.waitFor('tasksStopped', {
    cluster: clusterName,
    tasks: taskArns,
    $waiter: {
      delay: WAIT_DEFAULT_DELAY_SEC,
      maxAttempts: maxAttempts
    }
  }).promise();

  core.debug(`Run task response ${JSON.stringify(waitTaskResponse)}`)
  
  core.info(`All tasks have stopped. Watch progress in the Amazon ECS console: https://console.aws.amazon.com/ecs/home?region=${aws.config.region}#/clusters/${clusterName}/tasks`);
}

async function tasksExitCode(ecs, clusterName, taskArns) {
  const describeResponse = await ecs.describeTasks({
    cluster: clusterName,
    tasks: taskArns
  }).promise();

  const containers = [].concat(...describeResponse.tasks.map(task => task.containers))
  const exitCodes = containers.map(container => container.exitCode)
  const reasons = containers.map(container => container.reason)

  const failuresIdx = [];
  
  exitCodes.filter((exitCode, index) => {
    if (exitCode !== 0) {
      failuresIdx.push(index)
    }
  })

  const failures = reasons.filter((_, index) => failuresIdx.indexOf(index) !== -1)

  if (failures.length > 0) {
    core.setFailed(failures.join("\n"));
  } else {
    core.info(`All tasks have exited successfully.`);
  }
}

module.exports = run;

/* istanbul ignore next */
if (require.main === module) {
    run();
}
