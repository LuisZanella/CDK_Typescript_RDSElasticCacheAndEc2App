import { RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { aws_elasticache as elasticache, aws_iam as iam } from 'aws-cdk-lib';
import { readFileSync } from 'fs';

export class RdsElasticCacheStack extends Stack {
  APP_PORT = process.env.APP_PORT
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);  

    // Subnet
    const subnetPublicConfiguration: ec2.SubnetConfiguration = {
      name: 'publicSubnet',
      subnetType: ec2.SubnetType.PUBLIC,
      cidrMask: 24
    };

    const subnetPrivateConfiguration: ec2.SubnetConfiguration = {
      name: 'privateSubnet',
      subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      cidrMask: 24
    };

    // VPC
    const vpc = new ec2.Vpc(this, 'VPC-RDSElasticCache', {natGateways:1,
    cidr: "10.0.0.0/16",
    subnetConfiguration: [
      subnetPublicConfiguration,
      subnetPrivateConfiguration
    ]});
    
    // Security Groups
    const dbSecGroup = new ec2.SecurityGroup(this, "dbSecGroup", { securityGroupName: "dbSecGroup-DeleteME", vpc: vpc, allowAllOutbound: true})
    const webserverSecGroup = new ec2.SecurityGroup(this, "webserverSecGroup", { securityGroupName:"webserverSecGroup-DeleteME", vpc:vpc, allowAllOutbound:true})
    const redisSecGroup = new ec2.SecurityGroup(this, "redisSecGroup", { securityGroupName: "redisSecurityGroup-DeleteME", vpc:vpc, allowAllOutbound: true})
    
    const privateSubnetsIds = vpc.privateSubnets.map(e => e.subnetId)
    const redisSubnet = new elasticache.CfnSubnetGroup(this,'redisSubnetGroup', { subnetIds: privateSubnetsIds, description: "subnet group for redis" } )

    // Add ingress rules to security group
    webserverSecGroup.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(Number(this.APP_PORT)), "Flask Application")
    dbSecGroup.addIngressRule(webserverSecGroup, ec2.Port.tcp(3306) ,"Allow MySQL connection")
    redisSecGroup.addIngressRule(webserverSecGroup, ec2.Port.tcp(6379),"Allow Redis connection")


    // RDS MySQL Database
    const rdsInstance = new rds.DatabaseInstance(
      this, id='RDS-MySQL-DeleteMe', {
      databaseName:'covid',
      engine: rds.DatabaseInstanceEngine.mysql({ version:rds.MysqlEngineVersion.VER_8_0_28 }),
      vpc: vpc,
      port: 3306,
      instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.BURSTABLE3,
          ec2.InstanceSize.MICRO,
      ),
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
      iamAuthentication: true,
      securityGroups: [dbSecGroup],
      storageEncrypted: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_NAT}
    }
    )
    // Elasticache for Redis cluster
    const redisCluster = new elasticache.CfnCacheCluster(this, 'Redis Cluster', 
      { engine: 'redis', 
        cacheNodeType: 'cache.t3.micro', 
        numCacheNodes: 1, 
        cacheSubnetGroupName: redisSubnet.ref, 
        vpcSecurityGroupIds: [redisSecGroup.securityGroupId] 
    })

    // AMI definition
    const amazonLinux = ec2.MachineImage.latestAmazonLinux({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      edition: ec2.AmazonLinuxEdition.STANDARD,
      virtualization: ec2.AmazonLinuxVirt.HVM,
      storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE
    })

    // Instance Role and SSM Managed Policy
    const role = new iam.Role(this, "ElastiCacheInstancePolicy-DeleteMe",{assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com")})
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")) 
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSCloudFormationReadOnlyAccess"))

    // The following inline policy makes sure we allow only retrieving the secret value, provided the secret is already known. It does not allow listing of all secrets.
    role.attachInlinePolicy(new iam.Policy(this, "secretReadOnly-DeleteMe", { 
          statements:[new iam.PolicyStatement({
              actions:["secretsmanager:GetSecretValue"],
              resources:["arn:aws:secretsmanager:*"],
              effect:iam.Effect.ALLOW
      })]
    }))

    // EC2 Instance for Web Server
    const userDataScript = readFileSync('./lib/userData.sh', 'utf8');

    const instance = new ec2.Instance(this, "WebServer-DeleteMe",{
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: amazonLinux,
      vpc: vpc,
      role: role,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC},
      securityGroup: webserverSecGroup,
      userData: ec2.UserData.custom(userDataScript)
    })

    // Generate CloudFormation Outputs
    new CfnOutput(this,id="secretName",{ value: String(rdsInstance.secret?.secretName)})
    new CfnOutput(this,id="mysqlEndpoint-DeleteMe", { value: rdsInstance.dbInstanceEndpointAddress})
    new CfnOutput(this,id="redisEndpoint-DeleteMe", { value: redisCluster.attrRedisEndpointAddress})
    new CfnOutput(this,id="webserverPublicIp-DeleteMe", { value: instance.instancePublicIp})
    new CfnOutput(this,id="webserverPublicUrl-DeleteMe", { value: 'http://' + instance.instancePublicDnsName + ':' + String(this.APP_PORT)})
  }
}
