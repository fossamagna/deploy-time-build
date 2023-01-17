import { createHash } from 'crypto';
import { join } from 'path';
import { CustomResource, Duration, Size } from 'aws-cdk-lib';
import { IDistribution } from 'aws-cdk-lib/aws-cloudfront';
import { Code, Runtime, RuntimeFamily, SingletonFunction } from 'aws-cdk-lib/aws-lambda';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { Asset, AssetProps } from 'aws-cdk-lib/aws-s3-assets';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { ResourceProperties } from './types';

export interface AssetConfig extends AssetProps {
  /**
   * Shell commands executed right after the asset zip is extracted to the build environment.
   * @default No command is executed.
   */
  readonly commands?: string[];
}

export interface NodejsBuildProps {
  /**
   * The AssetProps from which s3-assets are created and copied to the build environment.
   */
  readonly assets: AssetConfig[];
  /**
   * Environment variables injected to the build environment.
   * You can use CDK deploy-time values as well as literals.
   * @default {}
   */
  readonly buildEnvironment?: { [key: string]: string };
  /**
   * S3 Bucket to which your build artifacts are finally deployed.
   */
  readonly destinationBucket: IBucket;
  /**
   * Key prefix to deploy your build artifact.
   * @default '/'
   */
  readonly destinationKeyPrefix?: string;
  /**
   * The distribution you are using to publish you build artifact.
   * If any specified, the caches are invalidated on new artifact deployments.
   * @default No distribution
   */
  readonly distribution?: IDistribution;
  /**
   * Shell commands to build your project. They are executed on the working directory you specified.
   * @default ['npm run build']
   */
  readonly buildCommands?: string[];
  /**
   * The name of the working directory of build process in the build enironment.
   * @default assetProps[0].assetProps.path
   */
  readonly workingDirectory?: string;
  /**
   * The path to the directory that contains your build artifacts (relative to the working directory.)
   */
  readonly outputSourceDirectory: string;
}

export class NodejsBuild extends Construct {
  constructor(scope: Construct, id: string, props: NodejsBuildProps) {
    super(scope, id);

    const handler = new SingletonFunction(this, 'CustomResourceHandler', {
      // Use raw string to avoid from tightening CDK version requirement
      runtime: new Runtime('nodejs18.x', RuntimeFamily.NODEJS),
      code: Code.fromAsset(join(__dirname, '../lambda/nodejs-build/dist')),
      handler: 'index.handler',
      uuid: '25648b21-2c40-4f09-aa65-b6bbb0c44659', // generated for this construct
      lambdaPurpose: 'NodejsBuildCustomResourceHandler',
      timeout: Duration.minutes(10),
      memorySize: 1792,
      ephemeralStorageSize: Size.gibibytes(5),
    });

    let assetHash = 'nodejsBuild';
    const assets = props.assets.map((assetProps) => {
      const asset = new Asset(this, `Source-${assetProps.path.replace('/', '')}`, {
        ...assetProps,
      });
      assetHash += asset.assetHash;
      asset.grantRead(handler);
      return asset;
    });

    // generate a new asset hash that includes all the assets specified.
    const md5 = createHash('md5');
    assetHash = md5.update(assetHash).digest('hex');

    // use the asset bucket that are created by CDK bootstrap to store intermediate artifacts
    const bucket = assets[0].bucket;
    bucket.grantWrite(handler);

    const workingDirectory = props.workingDirectory ?? props.assets[0].path;

    const properties: ResourceProperties = {
      sources: props.assets.map((s, i) => ({
        sourceBucketName: assets[i].s3BucketName,
        sourceObjectKey: assets[i].s3ObjectKey,
        directoryName: s.path,
        commands: s.commands,
      })),
      destinationBucketName: bucket.bucketName,
      destinationObjectKey: `${assetHash}.zip`,
      workingDirectory,
      outputSourceDirectory: join(workingDirectory, props.outputSourceDirectory),
      environment: props.buildEnvironment,
      buildCommands: props.buildCommands ?? ['npm run build'],
    };

    const custom = new CustomResource(this, 'Resource', {
      serviceToken: handler.functionArn,
      resourceType: 'Custom::CDKNodejsBuild',
      properties,
    });

    const deploy = new BucketDeployment(this, 'Deploy', {
      sources: [Source.bucket(bucket, properties.destinationObjectKey)],
      destinationBucket: props.destinationBucket,
      destinationKeyPrefix: props.destinationKeyPrefix,
      distribution: props.distribution,
    });

    deploy.node.addDependency(custom);
  }
}
