import json
import logging
import os

from paho.mqtt import publish as mqtt_publish


logger = logging.getLogger(__name__)


class HazardActionPlanner:
    """Convert risk predictions into device actions and dashboard notifications."""

    def __init__(self, thresholds: dict):
        self.thresholds = thresholds

    def plan(self, prediction: dict) -> dict:
        score = prediction['risk_score']
        hazard_type = prediction['hazard_type']
        buzzer = score >= self.thresholds['buzzer_score']
        solenoid = score >= self.thresholds['solenoid_score'] or hazard_type in {
            'GAS_LEAK',
            'GAS_FIRE_COMPOUND_RISK',
        }
        dashboard = score >= self.thresholds['notification_score']

        return {
            'buzzer_alert': buzzer,
            'solenoid_valve_shutoff': solenoid,
            'dashboard_notification': dashboard,
            'relay_isolation_recommended': score >= self.thresholds['solenoid_score'],
            'notification': self._notification(prediction) if dashboard else None,
            'commands': self._commands(buzzer, solenoid, prediction),
        }

    @staticmethod
    def _notification(prediction: dict) -> dict:
        return {
            'title': f'{prediction["severity"].title()} safety risk: {prediction["hazard_type"]}',
            'message': prediction['explanation'],
            'risk_score': prediction['risk_score'],
            'severity': prediction['severity'],
        }

    @staticmethod
    def _commands(buzzer: bool, solenoid: bool, prediction: dict) -> list[dict]:
        commands = []
        if buzzer:
            commands.append({
                'target': 'gateway',
                'action': 'BUZZER_ALERT',
                'enabled': True,
                'risk_score': prediction['risk_score'],
            })
        if solenoid:
            commands.append({
                'target': 'gateway',
                'action': 'SHUT_SOLENOID',
                'enabled': True,
                'risk_score': prediction['risk_score'],
            })
        return commands


class MqttHazardDispatcher:
    """Publish hazard actions to the existing Aether MQTT command channel."""

    topic = os.getenv('HAZARD_MQTT_TOPIC', 'aether/pairing/command')

    def publish(self, mac_address: str | None, commands: list[dict]) -> dict:
        if not mac_address or not commands:
            return {'published': False, 'reason': 'No target MAC address or commands.'}

        broker = os.getenv('MQTT_BROKER', 'broker.hivemq.com')
        port = int(os.getenv('MQTT_PORT', 1883))
        user = os.getenv('MQTT_USER')
        password = os.getenv('MQTT_PASSWORD')
        auth = {'username': user, 'password': password} if user and password else None
        tls = self._tls_config(port)

        published = []
        for command in commands:
            payload = {
                'mac': mac_address,
                'action': command['action'],
                'enabled': command['enabled'],
                'risk_score': command['risk_score'],
            }
            mqtt_publish.single(
                self.topic,
                payload=json.dumps(payload),
                hostname=broker,
                port=port,
                auth=auth,
                tls=tls,
            )
            published.append(payload)

        logger.info('Published hazard commands for %s: %s', mac_address, published)
        return {'published': True, 'topic': self.topic, 'commands': published}

    @staticmethod
    def _tls_config(port: int):
        if port != 8883:
            return None
        import ssl

        return {'ca_certs': None, 'cert_reqs': ssl.CERT_NONE, 'tls_version': ssl.PROTOCOL_TLS}

