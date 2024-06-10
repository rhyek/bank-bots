package ynab

import (
	"encoding/json"
	"fmt"
	"regexp"
)

type ParsedYnabTransactionMemo struct {
	Ref  string
	Desc string
}

func ParseYnabTransactionMemo(memo *string) (ParsedYnabTransactionMemo, error) {
	parsed := ParsedYnabTransactionMemo{}
	memo_b := []byte(*memo)
	if json.Valid(memo_b) {
		err := json.Unmarshal(memo_b, &parsed)
		if err != nil {
			return parsed, err
		}
		if parsed.Ref == "" {
			return parsed, fmt.Errorf("ref was empty for memo %v", memo)
		}
	}

	rgx := regexp.MustCompile(`ref: ([\d_\(\)]+);`)
	if matches := rgx.FindStringSubmatch(*memo); matches != nil {
		parsed.Ref = matches[1]
	}

	rgx = regexp.MustCompile(`desc: (.+?);`)
	if matches := rgx.FindStringSubmatch(*memo); matches != nil {
		parsed.Desc = matches[1]
	}

	return parsed, nil
}
