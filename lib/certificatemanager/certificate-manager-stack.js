const { Stack, CfnOutput } = require('aws-cdk-lib');
const acm = require('aws-cdk-lib/aws-certificatemanager');

class CertificateManager extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    this.certificate = acm.Certificate.fromCertificateArn(
      this,
      'Certificate',
      props.certificateArn,
    );

    new CfnOutput(this, 'CertificateArn', {
      exportName: `${id}-certificate-arn`,
      value: props.certificateArn,
      description: 'ACM Certificate ARN',
    });
  }
}

module.exports = { CertificateManager };
