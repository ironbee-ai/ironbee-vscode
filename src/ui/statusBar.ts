import * as vscode from 'vscode';

/** Status-bar item: signed-out CTA, identity + active account, or a per-project setup CTA. */
export class StatusBar {
    private readonly item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.show();
        this.signedOut();
    }

    signedOut(): void {
        this.item.text = '$(shield) IronBee: sign in';
        this.item.tooltip = 'Sign in to IronBee';
        this.item.command = 'ironbee.signIn';
    }

    /** State (b): a CLI collector token exists but there's no Cognito session. */
    collectorOnly(): void {
        this.item.text = '$(shield) IronBee: sign in to manage accounts';
        this.item.tooltip = 'The IronBee CLI is authenticated; sign in to manage accounts.';
        this.item.command = 'ironbee.signIn';
    }

    signedIn(email: string | undefined, account: string | null | undefined): void {
        const acct: string = account ?? 'no account';
        this.item.text = `$(shield) IronBee: ${acct}`;
        this.item.tooltip = `Signed in${email ? ` as ${email}` : ''} — click to switch account`;
        this.item.command = 'ironbee.switchAccount';
    }

    needsProjectSetup(): void {
        this.item.text = '$(shield) IronBee: set up';
        this.item.tooltip = 'Set up IronBee for this project';
        this.item.command = 'ironbee.installIntoProject';
    }

    dispose(): void {
        this.item.dispose();
    }
}
