package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/awslabs/aws-sdk-go/aws"
	"github.com/awslabs/aws-sdk-go/gen/cloudformation"
	"github.com/flynn/flynn/pkg/random"
	r "github.com/flynn/flynn/util/release"
)

func main() {
	accessKeyID := os.Getenv("AWS_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("AWS_ACCESS_SECRET")
	securityToken := os.Getenv("AWS_SECURITY_TOKEN")

	if (accessKeyID == "" || secretAccessKey == "") && securityToken == "" {
		log.Fatal(errors.New("AWS_ACCESS_KEY_ID and AWS_ACCESS_SECRET or AWS_SECURITY_TOKEN must be set"))
	}

	baseClusterDomain := os.Getenv("BASE_CLUSTER_DOMAIN")
	if baseClusterDomain == "" {
		log.Fatal("BASE_CLUSTER_DOMAIN is required")
	}

	creds := aws.Creds(accessKeyID, secretAccessKey, securityToken)

	region := "us-east-1"

	cf := cloudformation.New(creds, region, &http.Client{})

	stackTemplateFile, err := os.Open("stack-template.json")
	if err != nil {
		log.Fatal(err)
	}
	var stackTemplateBuffer bytes.Buffer
	_, err = io.Copy(&stackTemplateBuffer, stackTemplateFile)
	if err != nil {
		log.Fatal(err)
	}
	stackTemplateString := stackTemplateBuffer.String()

	latestVersion, err := fetchLatestVersion()
	if err != nil {
		log.Fatal(err)
	}
	var imageID string
	for _, i := range latestVersion.Images {
		if i.Region == region {
			imageID = i.ID
			break
		}
	}
	if imageID == "" {
		log.Fatal(errors.New(fmt.Sprintf("No image found for region %s", region)))
	}

	clusterDomain := random.Hex(16) + baseClusterDomain

	res, err := cf.CreateStack(&cloudformation.CreateStackInput{
		OnFailure:        aws.String("ROLLBACK"),
		StackName:        aws.String("flynn"),
		Tags:             []cloudformation.Tag{},
		TemplateBody:     aws.String(stackTemplateString),
		TimeoutInMinutes: aws.Integer(10),
		Parameters: []cloudformation.Parameter{
			{
				ParameterKey:   aws.String("ImageId"),
				ParameterValue: aws.String(imageID),
			},
			{
				ParameterKey:   aws.String("ClusterDomain"),
				ParameterValue: aws.String(clusterDomain),
			},
		},
	})
	if err != nil {
		fmt.Printf("Error: %T{%v}\n", err, err)
		log.Fatal(err)
	}

	fmt.Println(*res.StackID)
	waitForStackCompletion(cf, res.StackID)
}

func fetchLatestVersion() (*r.EC2Version, error) {
	client := &http.Client{}
	resp, err := client.Get("https://dl.flynn.io/ec2/images.json")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New(fmt.Sprintf("Failed to fetch list of flynn images: %s", resp.Status))
	}
	dec := json.NewDecoder(resp.Body)
	var manifest *r.EC2Manifest
	err = dec.Decode(&manifest)
	if err != nil {
		return nil, err
	}
	if len(manifest.Versions) == 0 {
		return nil, errors.New("No versions in manifest")
	}
	return manifest.Versions[0], nil
}

func waitForStackCompletion(cf *cloudformation.CloudFormation, stackID aws.StringValue) {
	stackEvents := make([]cloudformation.StackEvent, 0)
	var stackState string
	var nextToken aws.StringValue

	var fetchStackEvents func()
	fetchStackEvents = func() {
		res, err := cf.DescribeStackEvents(&cloudformation.DescribeStackEventsInput{
			NextToken: nextToken,
			StackName: stackID,
		})
		if err != nil {
			switch err.(type) {
			case *url.Error:
				return
			default:
				fmt.Printf("Error: %T{%v}\n", err, err)
				log.Fatal(err)
			}
		}
		// NOTE: some events are not returned in order (i.e. completion event returned before progress event)
		for _, se := range res.StackEvents {
			stackEventExists := false
			for _, e := range stackEvents {
				if *e.EventID == *se.EventID {
					stackEventExists = true
					break
				}
			}
			if stackEventExists {
				continue
			}
			stackEvents = append(stackEvents, se)
			if se.ResourceType != nil && se.ResourceStatus != nil {
				if *se.ResourceType == "AWS::CloudFormation::Stack" {
					stackState = *se.ResourceStatus
				}
				fmt.Println(*se.ResourceType, *se.ResourceStatus)
				if se.ResourceStatusReason != nil {
					fmt.Printf("\t%s\n", *se.ResourceStatusReason)
				}
			}
		}
		if res.NextToken != nil {
			nextToken = res.NextToken
			fetchStackEvents()
		}
	}

	for {
		fetchStackEvents()
		if strings.HasSuffix(stackState, "_COMPLETE") {
			break
		}
		time.Sleep(1 * time.Second)
	}
}
